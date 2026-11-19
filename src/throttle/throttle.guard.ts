import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import {
  SKIP_THROTTLE_KEY,
  THROTTLE_KEY,
  ThrottleOptions,
} from 'src/common/decorators/throttle.decorator';
import { RedisService } from 'src/redis/redis.service';

const HIT = `
local count = redis.call('INCR', KEYS[1])
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}`;

@Injectable()
export class ThrottleGuard implements CanActivate {
  private readonly defaults: ThrottleOptions;

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.defaults = {
      limit: config.getOrThrow<number>('RATE_LIMIT_MAX_REQUESTS'),
      windowSeconds: config.getOrThrow<number>('RATE_LIMIT_WINDOW_SECONDS'),
    };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_THROTTLE_KEY, targets))
      return true;

    const { limit, windowSeconds } = {
      ...this.defaults,
      ...this.reflector.getAllAndOverride<Partial<ThrottleOptions>>(
        THROTTLE_KEY,
        targets,
      ),
    };

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const scope = `${context.getClass().name}.${context.getHandler().name}`;
    const [count, ttlMs] = (await this.redis.eval(
      HIT,
      [`nc:throttle:${scope}:${req.ip ?? 'unknown'}`],
      [windowSeconds * 1000],
    )) as [number, number];

    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - count));
    if (count <= limit) return true;

    res.setHeader('Retry-After', Math.ceil(ttlMs / 1000));
    throw new HttpException(
      'Too many requests; retry later',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
