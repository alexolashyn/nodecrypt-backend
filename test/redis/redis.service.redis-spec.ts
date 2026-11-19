import { connectRedis, sleep, TestRedis } from './helpers';

describe('RedisService against real Redis', () => {
  let r: TestRedis;

  beforeAll(() => {
    r = connectRedis();
  });
  afterAll(() => r.close());
  beforeEach(() => r.raw.flushdb());

  it('stores a value with its expiry', async () => {
    await r.service.setWithTTL('k', 'v', 30);

    expect(await r.service.get('k')).toBe('v');
    const ttl = await r.raw.ttl('k');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  describe('getdel', () => {
    it('hands the value to exactly one of many concurrent callers', async () => {
      await r.service.set('k', 'v');

      const results = await Promise.all(
        Array.from({ length: 20 }, () => r.service.getdel('k')),
      );

      expect(results.filter((v) => v === 'v')).toHaveLength(1);
      expect(await r.raw.exists('k')).toBe(0);
    });
  });

  describe('setIfAbsent', () => {
    it('writes only when the key is missing', async () => {
      expect(await r.service.setIfAbsent('k', 'first', 10_000)).toBe(true);
      expect(await r.service.setIfAbsent('k', 'second', 10_000)).toBe(false);
      expect(await r.service.get('k')).toBe('first');
    });
  });

  describe('locks', () => {
    it('grants a lock to only one of many concurrent callers', async () => {
      const tokens = await Promise.all(
        Array.from({ length: 10 }, () => r.service.acquireLock('lock', 10_000)),
      );

      expect(tokens.filter((t) => t !== null)).toHaveLength(1);
    });

    it('sets the lock expiry', async () => {
      await r.service.acquireLock('lock', 10_000);

      const pttl = await r.raw.pttl('lock');
      expect(pttl).toBeGreaterThan(0);
      expect(pttl).toBeLessThanOrEqual(10_000);
    });

    it('ignores a release with someone else’s token', async () => {
      await r.service.acquireLock('lock', 10_000);

      await r.service.releaseLock('lock', 'not-the-token');

      expect(await r.raw.exists('lock')).toBe(1);
    });

    it('frees the lock for its holder', async () => {
      const token = await r.service.acquireLock('lock', 10_000);

      await r.service.releaseLock('lock', token!);

      expect(await r.service.acquireLock('lock', 10_000)).not.toBeNull();
    });

    it('lets an expired holder neither block nor free its successor', async () => {
      const stale = await r.service.acquireLock('lock', 50);
      await sleep(100);
      const current = await r.service.acquireLock('lock', 10_000);
      expect(current).not.toBeNull();

      await r.service.releaseLock('lock', stale!);

      expect(await r.service.get('lock')).toBe(current);
    });
  });
});
