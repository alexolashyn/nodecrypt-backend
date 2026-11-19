import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { RequestContext } from './common/timing/stage-timer';
import type { TestFault } from './config/env.validation';

export function configureApp(app: INestApplication) {
  const config = app.get(ConfigService);

  app.use((_req: Request, res: Response, next: NextFunction) => {
    const context: RequestContext = {
      requestId: randomUUID(),
      requestStart: performance.now(),
    };
    Object.assign(res.locals, context);
    res.setHeader('X-Request-Id', context.requestId!);
    next();
  });
  app.use(cookieParser());
  app.enableCors({
    origin: config.getOrThrow<string>('CORS_ORIGIN'),
    credentials: true,
    exposedHeaders: ['X-Request-Id'],
  });

  const server = app.getHttpServer() as Server;
  server.requestTimeout =
    config.getOrThrow<number>('UPLOAD_REQUEST_TIMEOUT_SECONDS') * 1000;

  logTestMode(config);
}

function logTestMode(config: ConfigService) {
  const active = [
    config.get<string>('PINNING_MODE') === 'stub' &&
      `PINNING_MODE=stub (${config.get<number>('PINNING_STUB_DELAY_MS')} ms ±20%)`,
    (config.get<TestFault[]>('TEST_FAULTS') ?? []).length > 0 &&
      `TEST_FAULTS=${config.get<TestFault[]>('TEST_FAULTS')!.join(',')}`,
    config.get<boolean>('UPLOAD_TIMING_LOG') && 'UPLOAD_TIMING_LOG',
    config.get<boolean>('REDIS_TIMING_LOG') && 'REDIS_TIMING_LOG',
  ].filter(Boolean);
  if (active.length > 0)
    new Logger('TestMode').warn(`TEST MODE ACTIVE: ${active.join(' | ')}`);
}
