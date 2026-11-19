import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { NonceModule } from './nonce/nonce.module';
import { AuthModule } from './auth/auth.module';
import { ThrottleModule } from './throttle/throttle.module';
import { HealthModule } from './health/health.module';
import { RedisModule } from './redis/redis.module';
import { ConfigModule } from '@nestjs/config';
import { envSchema } from './config/env.validation';
import { CommonModule } from './common/common.module';
import { FilesModule } from './files/files.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (raw) => envSchema.parse(raw),
    }),
    CommonModule,
    NonceModule,
    AuthModule,
    ThrottleModule,
    RedisModule,
    HealthModule,
    FilesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
