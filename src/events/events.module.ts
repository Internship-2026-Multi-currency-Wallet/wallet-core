import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppConfig } from '../config/app-config.js';
import { REDIS } from '../redis/redis.module.js';
import { EventPublisher, EventSubscriber } from './event-bus.js';

/**
 * Provides `EventPublisher` and `EventSubscriber` for the events in `catalog.ts`,
 * prefixed with the environment (`APP_ENV`), e.g. `staging:rate.tick`.
 *
 *   await publisher.publish('rate.tick', tick);
 *   const off = await subscriber.subscribe('rate.tick', (tick) => ...);
 */
@Global()
@Module({
  providers: [
    {
      provide: EventPublisher,
      inject: [REDIS, AppConfig],
      useFactory: (redis: Redis, config: AppConfig) => new EventPublisher(redis, config.appEnv),
    },
    {
      provide: EventSubscriber,
      inject: [REDIS, AppConfig],
      useFactory: (redis: Redis, config: AppConfig) => {
        const logger = new Logger('EventSubscriber');
        return new EventSubscriber(redis.duplicate(), config.appEnv, (error, channel) =>
          logger.error(`Handler for "${channel}" failed: ${String(error)}`),
        );
      },
    },
  ],
  exports: [EventPublisher, EventSubscriber],
})
export class EventsModule implements OnApplicationShutdown {
  constructor(@Inject(EventSubscriber) private readonly subscriber: EventSubscriber) {}

  async onApplicationShutdown(): Promise<void> {
    await this.subscriber.close();
  }
}
