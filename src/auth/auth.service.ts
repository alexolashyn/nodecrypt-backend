import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { SiweMessage } from 'siwe';
import { NonceService } from 'src/nonce/nonce.service';
import { RedisService } from 'src/redis/redis.service';
import { VerifyDto } from './dto/verify.dto';

const REFRESH_TOKEN_PREFIX = 'refresh:';

@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly jwtService: JwtService,
    private readonly nonceService: NonceService,
    private readonly redisService: RedisService,
  ) {}

  public async verify({ message, signature }: VerifyDto) {
    let siweMessage: SiweMessage;
    try {
      siweMessage = new SiweMessage(message);
    } catch {
      throw new BadRequestException('Malformed SIWE message');
    }

    const domain = new URL(this.config.getOrThrow('CORS_ORIGIN')).hostname;

    try {
      await siweMessage.verify({ signature, domain });
    } catch {
      throw new UnauthorizedException('Signature verification failed');
    }

    const nonceValid = await this.nonceService.consumeNonce(siweMessage.nonce);
    if (!nonceValid) {
      throw new UnauthorizedException(
        'Nonce is invalid, expired, or already used',
      );
    }

    return this.issueTokenPair(siweMessage.address);
  }

  public async refresh(refreshToken: string) {
    const address = await this.redisService.getdel(
      REFRESH_TOKEN_PREFIX + refreshToken,
    );
    if (!address) {
      throw new UnauthorizedException('Refresh token is invalid or expired');
    }

    return this.issueTokenPair(address);
  }

  public async logout(refreshToken: string) {
    await this.redisService.del(REFRESH_TOKEN_PREFIX + refreshToken);
    return { loggedOut: true };
  }

  private async issueTokenPair(address: string) {
    const accessToken = await this.jwtService.signAsync({ sub: address });

    const refreshToken = randomBytes(32).toString('base64url');
    await this.redisService.setWithTTL(
      REFRESH_TOKEN_PREFIX + refreshToken,
      address,
      this.config.getOrThrow('REFRESH_TOKEN_TTL_SECONDS'),
    );

    return { accessToken, refreshToken, address };
  }
}
