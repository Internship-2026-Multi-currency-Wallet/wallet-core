import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, type ThrottlerModuleOptions } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { getRequest } from '../auth/request-context.js';
import { AppConfig } from '../config/app-config.js';
import { REDIS } from '../redis/redis.module.js';
import { FailOpenThrottlerStorage } from './fail-open-storage.js';
import { GlobalThrottlerGuard } from './global-throttler.guard.js';
import { WindowThrottlerStorage } from './window-throttler-storage.js';

export function throttlerOptions(
  config: AppConfig,
  redis: Redis,
  logger: PinoLogger,
): ThrottlerModuleOptions {
  logger.setContext('Throttling');
  return {
    throttlers: [
      {
        ttl: config.throttle.ttlSeconds * 1000,
        limit: (context) =>
          getRequest(context).user ? config.throttle.limitUser : config.throttle.limitAnonymous,
      },
    ],
    storage: new FailOpenThrottlerStorage(new WindowThrottlerStorage(redis), redis, logger),
  };
}

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [AppConfig, REDIS, PinoLogger],
      useFactory: throttlerOptions,
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: GlobalThrottlerGuard }],
})
export class ThrottlingModule {}
