import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ThrottleGuard } from 'src/throttle/throttle.guard';
import { connectRedis, sleep, TestRedis } from './helpers';

class TestController {
  open() {}
}

const KEY = 'nc:throttle:TestController.open:1.1.1.1';

function hit(guard: ThrottleGuard, ip = '1.1.1.1') {
  const ctx = {
    getClass: () => TestController,
    getHandler: () =>
      (TestController.prototype as unknown as Record<string, unknown>).open,
    switchToHttp: () => ({
      getRequest: () => ({ ip }),
      getResponse: () => ({ setHeader: () => undefined }),
    }),
  } as unknown as ExecutionContext;
  return guard.canActivate(ctx);
}

describe('ThrottleGuard against real Redis', () => {
  let r: TestRedis;

  const guard = (limit: number, windowSeconds: number) =>
    new ThrottleGuard(
      new Reflector(),
      r.service,
      new ConfigService({
        RATE_LIMIT_MAX_REQUESTS: limit,
        RATE_LIMIT_WINDOW_SECONDS: windowSeconds,
      }),
    );

  beforeAll(() => {
    r = connectRedis();
  });
  afterAll(() => r.close());
  beforeEach(() => r.raw.flushdb());

  it('allows the limit and refuses the next request with 429', async () => {
    const g = guard(3, 60);
    for (let i = 0; i < 3; i++) await expect(hit(g)).resolves.toBe(true);

    const err = await hit(g).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
  });

  it('lets exactly the limit through a concurrent burst', async () => {
    const g = guard(3, 60);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => hit(g)),
    );

    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(3);
    expect(await r.raw.get(KEY)).toBe('10');
  });

  it('starts the window on the first hit and never extends it', async () => {
    const g = guard(100, 60);
    await hit(g);
    const first = await r.raw.pttl(KEY);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(60_000);

    await sleep(50);
    await hit(g);

    expect(await r.raw.pttl(KEY)).toBeLessThan(first);
  });

  it('opens a fresh budget once the window expires', async () => {
    const g = guard(1, 1);
    await hit(g);
    await expect(hit(g)).rejects.toBeInstanceOf(HttpException);

    await sleep(1_100);

    await expect(hit(g)).resolves.toBe(true);
  });

  it('keeps separate budgets per IP', async () => {
    const g = guard(1, 60);
    await hit(g, '1.1.1.1');

    await expect(hit(g, '2.2.2.2')).resolves.toBe(true);
    await expect(hit(g, '1.1.1.1')).rejects.toBeInstanceOf(HttpException);
  });
});
