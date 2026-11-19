import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AuthController } from './auth.controller';

const PAIR = {
  accessToken: 'access',
  refreshToken: 'refresh-new',
  address: '0xabc',
};

function setup(nodeEnv = 'development') {
  const auth = {
    verify: jest.fn().mockResolvedValue(PAIR),
    refresh: jest.fn().mockResolvedValue(PAIR),
    logout: jest.fn().mockResolvedValue({ loggedOut: true }),
  };
  const nonces = { getNonce: jest.fn().mockResolvedValue({ nonce: 'n' }) };
  const config = new ConfigService({
    NODE_ENV: nodeEnv,
    REFRESH_TOKEN_TTL_SECONDS: 3600,
  });
  const controller = new AuthController(config, nonces as never, auth as never);
  const res = { cookie: jest.fn(), clearCookie: jest.fn() };
  const req = (cookies?: Record<string, unknown>) =>
    ({ cookies }) as unknown as Request;
  return { controller, auth, res, response: res as unknown as Response, req };
}

describe('AuthController', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  describe('verify', () => {
    it('puts the refresh token in a locked-down cookie, not in the body', async () => {
      const body = await ctx.controller.verify(
        { message: 'm', signature: 's' },
        ctx.response,
      );

      expect(body).toEqual({ accessToken: 'access', address: '0xabc' });
      expect(ctx.res.cookie).toHaveBeenCalledWith(
        'refreshToken',
        'refresh-new',
        {
          httpOnly: true,
          secure: false,
          sameSite: 'lax',
          path: '/auth',
          maxAge: 3_600_000,
        },
      );
    });

    it('marks the cookie secure in production', async () => {
      const prod = setup('production');

      await prod.controller.verify(
        { message: 'm', signature: 's' },
        prod.response,
      );

      expect(prod.res.cookie).toHaveBeenCalledWith(
        'refreshToken',
        'refresh-new',
        expect.objectContaining({ secure: true }),
      );
    });
  });

  describe('refresh', () => {
    it('rotates the cookie with the token from the current one', async () => {
      const body = await ctx.controller.refresh(
        ctx.req({ refreshToken: 'refresh-old' }),
        ctx.response,
      );

      expect(ctx.auth.refresh).toHaveBeenCalledWith('refresh-old');
      expect(body).toEqual({ accessToken: 'access', address: '0xabc' });
      expect(ctx.res.cookie).toHaveBeenCalledWith(
        'refreshToken',
        'refresh-new',
        expect.any(Object),
      );
    });

    it('rejects a request without the cookie', async () => {
      await expect(
        ctx.controller.refresh(ctx.req(), ctx.response),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(ctx.auth.refresh).not.toHaveBeenCalled();
    });

    it('treats a JSON cookie (parsed into an object) as no token', async () => {
      await expect(
        ctx.controller.refresh(
          ctx.req({ refreshToken: { $ne: null } }),
          ctx.response,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(ctx.auth.refresh).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('revokes the token and clears the cookie on its path', async () => {
      await ctx.controller.logout(
        ctx.req({ refreshToken: 'refresh-old' }),
        ctx.response,
      );

      expect(ctx.auth.logout).toHaveBeenCalledWith('refresh-old');
      expect(ctx.res.clearCookie).toHaveBeenCalledWith('refreshToken', {
        path: '/auth',
      });
    });

    it('still clears the cookie when there is no token to revoke', async () => {
      const body = await ctx.controller.logout(ctx.req(), ctx.response);

      expect(body).toEqual({ loggedOut: true });
      expect(ctx.auth.logout).not.toHaveBeenCalled();
      expect(ctx.res.clearCookie).toHaveBeenCalled();
    });
  });
});
