import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from 'src/redis/redis.service';

const GLOBAL_KEY = 'nc:uploads:global';

const ACQUIRE = `
local user = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
local global = redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
if user > tonumber(ARGV[1]) or global > tonumber(ARGV[2]) then
  redis.call('DECR', KEYS[1])
  redis.call('DECR', KEYS[2])
  return 0
end
return 1`;

const RELEASE = `
for _, key in ipairs(KEYS) do
  if tonumber(redis.call('GET', key) or '0') > 0 then redis.call('DECR', key) end
end
return 1`;

@Injectable()
export class UploadGate {
  private readonly perUser: number;
  private readonly global: number;
  private readonly ttlMs: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.perUser = config.getOrThrow<number>('UPLOAD_MAX_CONCURRENT_PER_USER');
    this.global = config.getOrThrow<number>('UPLOAD_MAX_CONCURRENT_GLOBAL');
    this.ttlMs =
      config.getOrThrow<number>('UPLOAD_REQUEST_TIMEOUT_SECONDS') * 1000;
  }

  async run<T>(owner: string, fn: () => Promise<T>): Promise<T> {
    const keys = [`nc:uploads:user:${owner}`, GLOBAL_KEY];
    const granted = await this.redis.eval(ACQUIRE, keys, [
      this.perUser,
      this.global,
      this.ttlMs,
    ]);
    if (granted !== 1) {
      throw new HttpException(
        'Too many concurrent uploads; retry later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    try {
      return await fn();
    } finally {
      await this.redis.eval(RELEASE, keys, []);
    }
  }
}
