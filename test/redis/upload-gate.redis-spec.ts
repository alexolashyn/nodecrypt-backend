import { HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadGate } from 'src/files/upload-gate.service';
import { connectRedis, deferred, TestRedis } from './helpers';

const GLOBAL = 'nc:uploads:global';
const user = (owner: string) => `nc:uploads:user:${owner}`;

describe('UploadGate against real Redis', () => {
  let r: TestRedis;
  let gate: UploadGate;

  beforeAll(() => {
    r = connectRedis();
    gate = new UploadGate(
      r.service,
      new ConfigService({
        UPLOAD_MAX_CONCURRENT_PER_USER: 2,
        UPLOAD_MAX_CONCURRENT_GLOBAL: 3,
        UPLOAD_REQUEST_TIMEOUT_SECONDS: 60,
      }),
    );
  });
  afterAll(() => r.close());
  beforeEach(() => r.raw.flushdb());

  const expect429 = async (p: Promise<unknown>) => {
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
  };

  const acquired = () => r.service.get('sync');

  it('holds a slot while the upload runs and frees it afterwards', async () => {
    const upload = deferred();
    const running = gate.run('alice', () => upload.promise);
    await acquired();

    expect(await r.raw.get(user('alice'))).toBe('1');
    expect(await r.raw.get(GLOBAL)).toBe('1');

    upload.resolve();
    await running;

    expect(await r.raw.get(user('alice'))).toBe('0');
    expect(await r.raw.get(GLOBAL)).toBe('0');
  });

  it('refuses a user over the per-user limit', async () => {
    const upload = deferred();
    const running = [1, 2].map(() => gate.run('alice', () => upload.promise));

    await expect429(gate.run('alice', () => Promise.resolve()));

    upload.resolve();
    await Promise.all(running);
  });

  it('refuses at the global limit and rolls back both counters', async () => {
    const upload = deferred();
    const running = [
      gate.run('alice', () => upload.promise),
      gate.run('alice', () => upload.promise),
      gate.run('bob', () => upload.promise),
    ];

    await expect429(gate.run('carol', () => Promise.resolve()));
    expect(await r.raw.get(user('carol'))).toBe('0');
    expect(await r.raw.get(GLOBAL)).toBe('3');

    upload.resolve();
    await Promise.all(running);
    expect(await r.raw.get(GLOBAL)).toBe('0');
  });

  it('frees the slot when the upload throws', async () => {
    await expect(
      gate.run('alice', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    expect(await r.raw.get(user('alice'))).toBe('0');
    expect(await r.raw.get(GLOBAL)).toBe('0');
  });

  it('sets an expiry so a crashed process cannot hold a slot forever', async () => {
    const upload = deferred();
    const running = gate.run('alice', () => upload.promise);
    await acquired();

    for (const key of [user('alice'), GLOBAL]) {
      const pttl = await r.raw.pttl(key);
      expect(pttl).toBeGreaterThan(0);
      expect(pttl).toBeLessThanOrEqual(60_000);
    }

    upload.resolve();
    await running;
  });

  it('never drives a counter negative after the key expired mid-upload', async () => {
    const upload = deferred();
    const running = gate.run('alice', () => upload.promise);
    await acquired();
    await r.raw.del(user('alice'), GLOBAL);

    upload.resolve();
    await running;

    expect(await r.raw.get(user('alice'))).toBeNull();
    expect(await r.raw.get(GLOBAL)).toBeNull();
  });
});
