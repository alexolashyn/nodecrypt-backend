import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Public } from 'src/common/decorators/public.decorator';
import { JwtStrategy } from '../strategies/jwt.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';

const SECRET = 'x'.repeat(32);
const ADDRESS = '0x00000000000000000000000000000000000000aA';

class ProtectedController {
  handler() {}

  @Public()
  open() {}
}

@Public()
class PublicController {
  handler() {}
}

function context(
  cls: { prototype: object },
  handler: string,
  authorization?: string,
) {
  const request: { headers: Record<string, string>; user?: unknown } = {
    headers: authorization ? { authorization } : {},
  };
  const ctx = {
    getClass: () => cls,
    getHandler: () => (cls.prototype as Record<string, unknown>)[handler],
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => () => undefined,
    }),
  } as unknown as ExecutionContext;
  return { ctx, request };
}

describe('JwtAuthGuard with JwtStrategy', () => {
  const jwt = new JwtService({ secret: SECRET });
  let guard: JwtAuthGuard;

  beforeAll(() => {
    new JwtStrategy(new ConfigService({ JWT_SECRET: SECRET }));
    guard = new JwtAuthGuard(new Reflector());
  });

  const bearer = (token: string) => `Bearer ${token}`;

  it('lets a @Public route through without a token', async () => {
    const { ctx } = context(ProtectedController, 'open');

    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('lets every route of a @Public controller through', async () => {
    const { ctx } = context(PublicController, 'handler');

    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('accepts a valid token and exposes the address as request.user', async () => {
    const token = await jwt.signAsync({ sub: ADDRESS }, { expiresIn: '1h' });
    const { ctx, request } = context(
      ProtectedController,
      'handler',
      bearer(token),
    );

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.user).toEqual({ address: ADDRESS });
  });

  it('rejects a request without a token', async () => {
    const { ctx } = context(ProtectedController, 'handler');

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an expired token', async () => {
    const token = await jwt.signAsync({
      sub: ADDRESS,
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    const { ctx } = context(ProtectedController, 'handler', bearer(token));

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token signed with another secret', async () => {
    const forged = await new JwtService({ secret: 'y'.repeat(32) }).signAsync(
      { sub: ADDRESS },
      { expiresIn: '1h' },
    );
    const { ctx } = context(ProtectedController, 'handler', bearer(forged));

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token that is not sent as a Bearer header', async () => {
    const token = await jwt.signAsync({ sub: ADDRESS }, { expiresIn: '1h' });
    const { ctx } = context(ProtectedController, 'handler', token);

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
