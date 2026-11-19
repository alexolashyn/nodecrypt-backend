import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottleGuard } from './throttle.guard';

@Module({
  providers: [{ provide: APP_GUARD, useClass: ThrottleGuard }],
})
export class ThrottleModule {}
