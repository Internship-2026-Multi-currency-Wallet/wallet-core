import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module.js';
import { EventPublisher, EventSubscriber } from './event-bus.js';

/**
 * Provides `EventPublisher` and `EventSubscriber` for the events in `catalog.ts`.
 *
 *   await publisher.publish('rate.tick', tick);
 *   const off = await subscriber.subscribe('rate.tick', (tick) => ...);
 */
@Global()
@Module({
  providers: [
    {
      provide: EventPublisher,
      inject: [REDIS],
      useFactory: (redis: Redis) => new EventPublisher(redis),
    },
    {
      provide: EventSubscriber,
      inject: [REDIS],
      useFactory: (redis: Redis) => {
        const logger = new Logger('EventSubscriber');
        return new EventSubscriber(redis.duplicate(), (error, channel) =>
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
