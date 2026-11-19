import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { NonceService } from 'src/nonce/nonce.service';
import { Public } from 'src/common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { VerifyDto } from './dto/verify.dto';

const REFRESH_TOKEN_COOKIE = 'refreshToken';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly config: ConfigService,
    private readonly nonceService: NonceService,
    private readonly authService: AuthService,
  ) {}

  @Public()
  @Get('nonce')
  public async getNonce() {
    return this.nonceService.getNonce();
  }

  @Public()
  @Post('verify')
  public async verify(
    @Body() verifyDto: VerifyDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken, address } =
      await this.authService.verify(verifyDto);
    this.setRefreshTokenCookie(res, refreshToken);
    return { accessToken, address };
  }

  @Public()
  @Post('refresh')
  public async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const currentRefreshToken = this.readRefreshToken(req);
    if (!currentRefreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }

    const { accessToken, refreshToken, address } =
      await this.authService.refresh(currentRefreshToken);
    this.setRefreshTokenCookie(res, refreshToken);
    return { accessToken, address };
  }

  @Public()
  @Post('logout')
  public async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const currentRefreshToken = this.readRefreshToken(req);
    if (currentRefreshToken) {
      await this.authService.logout(currentRefreshToken);
    }
    res.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/auth' });
    return { loggedOut: true };
  }

  private readRefreshToken(req: Request): string | undefined {
    const value: unknown = req.cookies?.[REFRESH_TOKEN_COOKIE];
    return typeof value === 'string' ? value : undefined;
  }

  private setRefreshTokenCookie(res: Response, refreshToken: string) {
    res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
      httpOnly: true,
      secure: this.config.get('NODE_ENV') === 'production',
      sameSite: 'lax',
      path: '/auth',
      maxAge:
        this.config.getOrThrow<number>('REFRESH_TOKEN_TTL_SECONDS') * 1000,
    });
  }
}
