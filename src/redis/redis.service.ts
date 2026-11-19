import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ConfigService } from '@nestjs/config';
import { roundMs, writeJsonLine } from 'src/common/timing/json-log';

export function keyPrefix(key: string): string {
  const parts = key.split(':');
  return parts[0] === 'nc' ? parts.slice(0, 2).join(':') : parts[0];
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly timingLog: boolean;
  private client!: Redis;

  constructor(private readonly config: ConfigService) {
    this.timingLog = config.get<boolean>('REDIS_TIMING_LOG') ?? false;
  }

  onModuleInit() {
    const redisUrl = new URL(this.config.getOrThrow('REDIS_URL'));
    this.client = new Redis({
      host: redisUrl.hostname,
      port: Number(redisUrl.port),
      password: this.config.getOrThrow('REDIS_PASSWORD'),
      retryStrategy: (times) => {
        if (times > 3) {
          this.logger.error('Redis connection failed after 3 retries');
          return null;
        }
        return Math.min(times * 500, 2000);
      },
    });

    this.client.on('connect', () => {
      this.logger.log(`Connected to Redis at ${redisUrl.hostname}`);
    });

    this.client.on('error', (err) => {
      this.logger.error('Redis error:', err.message);
    });
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  async ping(): Promise<boolean> {
    return (await this.client.ping()) === 'PONG';
  }

  async get(key: string): Promise<string | null> {
    return this.timed('get', key, () => this.client.get(key));
  }

  async set(key: string, value: string): Promise<void> {
    await this.timed('set', key, () => this.client.set(key, value));
  }

  async setWithTTL(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> {
    await this.timed('setex', key, () =>
      this.client.setex(key, ttlSeconds, value),
    );
  }

  async del(key: string): Promise<void> {
    await this.timed('del', key, () => this.client.del(key));
  }

  async increment(key: string): Promise<number> {
    return this.timed('incr', key, () => this.client.incr(key));
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.timed('expire', key, () => this.client.expire(key, ttlSeconds));
  }

  async getdel(key: string): Promise<string | null> {
    return this.timed('getdel', key, () => this.client.getdel(key));
  }

  async setIfAbsent(
    key: string,
    value: string,
    ttlMs: number,
  ): Promise<boolean> {
    const reply = await this.timed('setnx', key, () =>
      this.client.set(key, value, 'PX', ttlMs, 'NX'),
    );
    return reply === 'OK';
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.timed('hgetall', key, () => this.client.hgetall(key));
  }

  async hset(key: string, values: Record<string, string>): Promise<void> {
    await this.timed('hset', key, () => this.client.hset(key, values));
  }

  async smembers(key: string): Promise<string[]> {
    return this.timed('smembers', key, () => this.client.smembers(key));
  }

  async sadd(key: string, member: string): Promise<void> {
    await this.timed('sadd', key, () => this.client.sadd(key, member));
  }

  async srem(key: string, member: string): Promise<void> {
    await this.timed('srem', key, () => this.client.srem(key, member));
  }

  async scard(key: string): Promise<number> {
    return this.timed('scard', key, () => this.client.scard(key));
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    await this.timed('zadd', key, () => this.client.zadd(key, score, member));
  }

  async zrem(key: string, member: string): Promise<void> {
    await this.timed('zrem', key, () => this.client.zrem(key, member));
  }

  async zdue(key: string, maxScore: number, limit: number): Promise<string[]> {
    return this.timed('zrangebyscore', key, () =>
      this.client.zrangebyscore(key, '-inf', maxScore, 'LIMIT', 0, limit),
    );
  }

  async acquireLock(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    return (await this.setIfAbsent(key, token, ttlMs)) ? token : null;
  }

  async releaseLock(key: string, token: string): Promise<void> {
    await this.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
      [key],
      [token],
    );
  }

  async eval(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown> {
    return this.timed('eval', keys[0] ?? '', () =>
      this.client.eval(script, keys.length, ...keys, ...args),
    );
  }

  private async timed<T>(
    op: string,
    key: string,
    run: () => Promise<T>,
  ): Promise<T> {
    if (!this.timingLog) return run();
    const start = performance.now();
    let ok = false;
    try {
      const result = await run();
      ok = true;
      return result;
    } finally {
      writeJsonLine({
        type: 'redis_timing',
        op,
        keyPrefix: keyPrefix(key),
        ms: roundMs(performance.now() - start),
        ok,
      });
    }
  }
}
