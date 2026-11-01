import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfig } from '../config/app-config.js';

/** Injection token for the shared ioredis client (commands + publishing). */
export const REDIS = Symbol('REDIS');

export function createRedis(url: string): Redis {
  // lazyConnect: the app can start (and generate its schema) without Redis running.
  return new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => createRedis(config.redisUrl),
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status !== 'end' && this.redis.status !== 'wait') {
      await this.redis.quit();
      this.logger.log('Redis connection closed');
    } else {
      this.redis.disconnect();
    }
  }
}
