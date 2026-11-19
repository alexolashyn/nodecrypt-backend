import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisService } from 'src/redis/redis.service';

export interface TestRedis {
  service: RedisService;
  raw: Redis;
  close(): Promise<void>;
}

export function connectRedis(): TestRedis {
  const url = process.env.TEST_REDIS_URL;
  const password = process.env.TEST_REDIS_PASSWORD;
  if (!url || !password)
    throw new Error('TEST_REDIS_* is unset; run through npm run test:redis');

  const service = new RedisService(
    new ConfigService({ REDIS_URL: url, REDIS_PASSWORD: password }),
  );
  service.onModuleInit();
  const raw = new Redis(url, { password });

  return {
    service,
    raw,
    close: async () => {
      await service.onModuleDestroy();
      await raw.quit();
    },
  };
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
