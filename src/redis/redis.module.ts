import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Redis } from 'ioredis';
import { AppConfig } from '../config/app-config.js';
import {
  closeRedis,
  COMMAND_CLIENT_OPTIONS,
  SUBSCRIBER_CLIENT_OPTIONS,
  watchRedisConnection,
} from './redis-connection.js';

/** Injection token for the shared ioredis client (commands + publishing). */
export const REDIS = Symbol('REDIS');

export function createRedis(url: string): Redis {
  return new Redis(url, COMMAND_CLIENT_OPTIONS);
}

export function createSubscriberRedis(redis: Redis): Redis {
  return redis.duplicate(SUBSCRIBER_CLIENT_OPTIONS);
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [AppConfig, PinoLogger],
      useFactory: (config: AppConfig, logger: PinoLogger) => {
        logger.setContext('Redis');
        const redis = createRedis(config.redisUrl);
        watchRedisConnection(redis, logger, 'command');
        return redis;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @InjectPinoLogger(RedisModule.name) private readonly logger: PinoLogger,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    const wasReady = this.redis.status === 'ready';
    await closeRedis(this.redis);
    if (wasReady) this.logger.info('Redis connection closed');
  }
}
