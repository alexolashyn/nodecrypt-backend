import { Injectable } from '@nestjs/common';
import { generateNonce } from 'siwe';
import { RedisService } from 'src/redis/redis.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class NonceService {
  constructor(
    private readonly config: ConfigService,
    private readonly redisService: RedisService,
  ) {}

  public async getNonce() {
    const nonce = generateNonce();
    await this.redisService.setWithTTL(
      `nonce:${nonce}`,
      '1',
      this.config.getOrThrow('NONCE_TTL_SECONDS'),
    );
    return { nonce };
  }

  public async consumeNonce(nonce: string): Promise<boolean> {
    const key = `nonce:${nonce}`;
    const exists = await this.redisService.getdel(key);
    if (!exists) return false;
    return true;
  }
}
