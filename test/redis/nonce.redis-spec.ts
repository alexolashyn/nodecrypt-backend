import { ConfigService } from '@nestjs/config';
import { NonceService } from 'src/nonce/nonce.service';
import { connectRedis, TestRedis } from './helpers';

describe('NonceService against real Redis', () => {
  let r: TestRedis;
  let nonces: NonceService;

  beforeAll(() => {
    r = connectRedis();
    nonces = new NonceService(
      new ConfigService({ NONCE_TTL_SECONDS: 300 }),
      r.service,
    );
  });
  afterAll(() => r.close());
  beforeEach(() => r.raw.flushdb());

  it('stores an issued nonce with its TTL', async () => {
    const { nonce } = await nonces.getNonce();

    const ttl = await r.raw.ttl(`nonce:${nonce}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it('accepts a nonce once, even under concurrent replays', async () => {
    const { nonce } = await nonces.getNonce();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => nonces.consumeNonce(nonce)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await nonces.consumeNonce(nonce)).toBe(false);
  });

  it('rejects a nonce it never issued', async () => {
    expect(await nonces.consumeNonce('made-up')).toBe(false);
  });
});
