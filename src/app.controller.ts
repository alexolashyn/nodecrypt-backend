import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { RedisService } from './redis/redis.service';
import { Public } from './common/decorators/public.decorator';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Public()
  @Get('ping-redis')
  async pingRedis() {
    await this.redis.set('keepalive', 'active');
    const val = await this.redis.get('keepalive');
    return { status: 'ok', redis: val };
  }
}
