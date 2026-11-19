import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { HDNodeWallet, Wallet } from 'ethers';
import { SiweMessage } from 'siwe';
import { NonceService } from 'src/nonce/nonce.service';
import { AuthService } from './auth.service';

const SECRET = 'x'.repeat(32);

class FakeRedis {
  readonly store = new Map<string, { value: string; ttl: number }>();
  setWithTTL(key: string, value: string, ttl: number) {
    this.store.set(key, { value, ttl });
    return Promise.resolve();
  }
  getdel(key: string) {
    const entry = this.store.get(key);
    this.store.delete(key);
    return Promise.resolve(entry?.value ?? null);
  }
  del(key: string) {
    this.store.delete(key);
    return Promise.resolve();
  }
}

function setup() {
  const redis = new FakeRedis();
  const config = new ConfigService({
    CORS_ORIGIN: 'http://localhost:5173',
    NONCE_TTL_SECONDS: 300,
    REFRESH_TOKEN_TTL_SECONDS: 604_800,
  });
  const jwt = new JwtService({
    secret: SECRET,
    signOptions: { expiresIn: '1h' },
  });
  const nonces = new NonceService(config, redis as never);
  const service = new AuthService(config, jwt, nonces, redis as never);
  return { service, nonces, redis, jwt };
}

async function signIn(
  ctx: ReturnType<typeof setup>,
  overrides: Partial<SiweMessage> = {},
  { signer }: { signer?: HDNodeWallet } = {},
) {
  const wallet: HDNodeWallet = Wallet.createRandom();
  signer ??= wallet;
  const { nonce } = await ctx.nonces.getNonce();
  const message = new SiweMessage({
    domain: 'localhost',
    address: wallet.address,
    statement: 'Sign in to NodeCrypt',
    uri: 'http://localhost:5173',
    version: '1',
    chainId: 11155111,
    nonce,
    issuedAt: new Date().toISOString(),
    ...overrides,
  }).prepareMessage();
  const signature = await signer.signMessage(message);
  return { message, signature, wallet, nonce };
}

describe('AuthService', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  describe('verify', () => {
    it('issues an access token for the signer and stores the refresh token', async () => {
      const { message, signature, wallet } = await signIn(ctx);

      const result = await ctx.service.verify({ message, signature });

      expect(result.address).toBe(wallet.address);
      const payload = ctx.jwt.verify<{ sub: string }>(result.accessToken);
      expect(payload.sub).toBe(wallet.address);
      expect(ctx.redis.store.get(`refresh:${result.refreshToken}`)).toEqual({
        value: wallet.address,
        ttl: 604_800,
      });
    });

    it('consumes the nonce, so the same signed message cannot log in twice', async () => {
      const signed = await signIn(ctx);
      await ctx.service.verify(signed);

      await expect(ctx.service.verify(signed)).rejects.toThrow(
        'Nonce is invalid, expired, or already used',
      );
    });

    it('rejects a message that is not SIWE with 400', async () => {
      await expect(
        ctx.service.verify({ message: 'hello', signature: '0x00' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a signature from a different wallet', async () => {
      const signed = await signIn(ctx, {}, { signer: Wallet.createRandom() });

      await expect(ctx.service.verify(signed)).rejects.toThrow(
        new UnauthorizedException('Signature verification failed'),
      );
    });

    it('rejects a message signed for another domain', async () => {
      const signed = await signIn(ctx, { domain: 'evil.example' });

      await expect(ctx.service.verify(signed)).rejects.toThrow(
        'Signature verification failed',
      );
    });

    it('rejects an expired message', async () => {
      const signed = await signIn(ctx, {
        issuedAt: new Date(Date.now() - 120_000).toISOString(),
        expirationTime: new Date(Date.now() - 60_000).toISOString(),
      });

      await expect(ctx.service.verify(signed)).rejects.toThrow(
        'Signature verification failed',
      );
    });

    it('rejects a nonce the server never issued', async () => {
      const signed = await signIn(ctx, { nonce: 'neverissued123' });

      await expect(ctx.service.verify(signed)).rejects.toThrow(
        'Nonce is invalid, expired, or already used',
      );
    });

    it('does not burn the nonce on a bad signature', async () => {
      const good = await signIn(ctx);
      const forged = {
        message: good.message,
        signature: await Wallet.createRandom().signMessage(good.message),
      };

      await expect(ctx.service.verify(forged)).rejects.toThrow(
        'Signature verification failed',
      );
      await expect(ctx.service.verify(good)).resolves.toHaveProperty(
        'accessToken',
      );
    });
  });

  describe('refresh', () => {
    it('rotates the pair: the new token works, the old one is dead', async () => {
      const { wallet, ...signed } = await signIn(ctx);
      const first = await ctx.service.verify(signed);

      const second = await ctx.service.refresh(first.refreshToken);

      expect(second.address).toBe(wallet.address);
      expect(second.refreshToken).not.toBe(first.refreshToken);
      await expect(ctx.service.refresh(first.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(
        ctx.service.refresh(second.refreshToken),
      ).resolves.toHaveProperty('address', wallet.address);
    });

    it('rejects an unknown token', async () => {
      await expect(ctx.service.refresh('made-up')).rejects.toThrow(
        'Refresh token is invalid or expired',
      );
    });
  });

  describe('logout', () => {
    it('revokes the refresh token', async () => {
      const { refreshToken } = await ctx.service.verify(await signIn(ctx));

      await ctx.service.logout(refreshToken);

      await expect(ctx.service.refresh(refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
