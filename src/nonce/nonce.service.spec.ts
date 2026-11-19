import { ConfigService } from '@nestjs/config';
import { NonceService } from './nonce.service';

function setup() {
  const store = new Map<string, string>();
  const redis = {
    setWithTTL: jest.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    getdel: jest.fn((key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return Promise.resolve(value);
    }),
  };
  const service = new NonceService(
    new ConfigService({ NONCE_TTL_SECONDS: 300 }),
    redis as never,
  );
  return { service, redis };
}

describe('NonceService', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it('issues an alphanumeric nonce and stores it with the configured TTL', async () => {
    const { nonce } = await ctx.service.getNonce();

    expect(nonce).toMatch(/^[a-zA-Z0-9]{8,}$/);
    expect(ctx.redis.setWithTTL).toHaveBeenCalledWith(
      `nonce:${nonce}`,
      '1',
      300,
    );
  });

  it('issues a different nonce every time', async () => {
    const a = await ctx.service.getNonce();
    const b = await ctx.service.getNonce();

    expect(a.nonce).not.toBe(b.nonce);
  });

  it('accepts an issued nonce once', async () => {
    const { nonce } = await ctx.service.getNonce();

    expect(await ctx.service.consumeNonce(nonce)).toBe(true);
    expect(await ctx.service.consumeNonce(nonce)).toBe(false);
  });

  it('rejects a nonce it never issued', async () => {
    expect(await ctx.service.consumeNonce('made-up')).toBe(false);
  });
});
