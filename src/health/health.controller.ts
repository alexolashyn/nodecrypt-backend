import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from 'src/common/decorators/public.decorator';
import { SkipThrottle } from 'src/common/decorators/throttle.decorator';
import { RedisService } from 'src/redis/redis.service';

const REDIS_TIMEOUT_MS = 1000;

@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly redis: RedisService) {}

  @Get()
  async check() {
    const timeout = new Promise<false>((resolve) =>
      setTimeout(() => resolve(false), REDIS_TIMEOUT_MS).unref(),
    );
    const up = await Promise.race([
      this.redis.ping().catch(() => false),
      timeout,
    ]);
    if (!up) throw new ServiceUnavailableException('Redis is not responding');
    return { status: 'ok', redis: 'up' };
  }
}
