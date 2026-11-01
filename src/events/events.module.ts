import { randomUUID } from 'node:crypto';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { REDIS } from '../redis/redis.module.js';
import { type EventContext, EventPublisher, EventSubscriber } from './event-bus.js';

/**
 * Connects the event helpers to the logging context: an outgoing event carries the `requestId`
 * of the current request, and a handler of an incoming event logs with that same `requestId`.
 */
export function loggingEventContext(logger: PinoLogger, service: string): EventContext {
  return {
    current: () => {
      const requestId: unknown = logger.logger.bindings().requestId;
      return typeof requestId === 'string'
        ? { requestId, publisher: service }
        : { publisher: service };
    },
    run: (meta, fn) =>
      logger.runInContext(fn, { bindings: { requestId: meta.requestId ?? randomUUID() } }),
  };
}

/**
 * Provides `EventPublisher` and `EventSubscriber` for the events in `catalog.ts`,
 * prefixed with the environment (`APP_ENV`), e.g. `staging:rate.tick`.
 *
 *   await publisher.publish('rate.tick', tick);
 *   const off = await subscriber.subscribe('rate.tick', (tick, meta) => ...);
 */
@Global()
@Module({
  providers: [
    {
      provide: EventPublisher,
      inject: [REDIS, AppConfig, PinoLogger],
      useFactory: (redis: Redis, config: AppConfig, logger: PinoLogger) =>
        new EventPublisher(redis, config.appEnv, loggingEventContext(logger, config.serviceName)),
    },
    {
      provide: EventSubscriber,
      inject: [REDIS, AppConfig, PinoLogger],
      useFactory: (redis: Redis, config: AppConfig, logger: PinoLogger) => {
        logger.setContext('EventSubscriber');
        return new EventSubscriber(
          redis.duplicate(),
          config.appEnv,
          (error, channel) =>
            logger.error({ err: error, channel }, `Handler for "${channel}" failed`),
          loggingEventContext(logger, config.serviceName),
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
