import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  SkipThrottle,
  Throttle,
} from 'src/common/decorators/throttle.decorator';
import { ThrottleGuard } from './throttle.guard';

class TestController {
  open() {}

  @Throttle({ limit: 2 })
  strict() {}

  @SkipThrottle()
  skipped() {}
}

@SkipThrottle()
class SkippedController {
  open() {}
}

function context(
  cls: { prototype: object; name: string },
  handler: string,
  ip = '1.2.3.4',
) {
  const res = { setHeader: jest.fn() };
  const ctx = {
    getClass: () => cls,
    getHandler: () => (cls.prototype as Record<string, unknown>)[handler],
    switchToHttp: () => ({
      getRequest: () => ({ ip }),
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
  return { ctx, res };
}

function setup() {
  const redis = { eval: jest.fn().mockResolvedValue([1, 60_000]) };
  const config = new ConfigService({
    RATE_LIMIT_MAX_REQUESTS: 10,
    RATE_LIMIT_WINDOW_SECONDS: 60,
  });
  const guard = new ThrottleGuard(new Reflector(), redis as never, config);
  return { guard, redis };
}

describe('ThrottleGuard', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it('counts the hit per route and IP with the default window', async () => {
    const { ctx: exec } = context(TestController, 'open', '9.9.9.9');

    await expect(ctx.guard.canActivate(exec)).resolves.toBe(true);
    expect(ctx.redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      ['nc:throttle:TestController.open:9.9.9.9'],
      [60_000],
    );
  });

  it('reports the remaining budget', async () => {
    ctx.redis.eval.mockResolvedValue([4, 30_000]);
    const { ctx: exec, res } = context(TestController, 'open');

    await ctx.guard.canActivate(exec);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 10);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 6);
  });

  it('allows the request that reaches the limit exactly', async () => {
    ctx.redis.eval.mockResolvedValue([10, 30_000]);
    const { ctx: exec } = context(TestController, 'open');

    await expect(ctx.guard.canActivate(exec)).resolves.toBe(true);
  });

  it('refuses with 429 and Retry-After once over the limit', async () => {
    ctx.redis.eval.mockResolvedValue([11, 12_300]);
    const { ctx: exec, res } = context(TestController, 'open');

    const err = await ctx.guard.canActivate(exec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 0);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 13);
  });

  it('applies a route override and keeps the default window', async () => {
    ctx.redis.eval.mockResolvedValue([3, 50_000]);
    const { ctx: exec } = context(TestController, 'strict');

    await expect(ctx.guard.canActivate(exec)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(ctx.redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      ['nc:throttle:TestController.strict:1.2.3.4'],
      [60_000],
    );
  });

  it('skips a route marked @SkipThrottle without touching Redis', async () => {
    const { ctx: exec } = context(TestController, 'skipped');

    await expect(ctx.guard.canActivate(exec)).resolves.toBe(true);
    expect(ctx.redis.eval).not.toHaveBeenCalled();
  });

  it('skips every route of a controller marked @SkipThrottle', async () => {
    const { ctx: exec } = context(SkippedController, 'open');

    await expect(ctx.guard.canActivate(exec)).resolves.toBe(true);
    expect(ctx.redis.eval).not.toHaveBeenCalled();
  });
});
