import { randomUUID } from 'node:crypto';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { Metrics } from '../metrics/metrics.js';
import { watchRedisConnection } from '../redis/redis-connection.js';
import { createSubscriberRedis, REDIS } from '../redis/redis.module.js';
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
      inject: [REDIS, AppConfig, PinoLogger, Metrics],
      useFactory: (redis: Redis, config: AppConfig, logger: PinoLogger, metrics: Metrics) => {
        const published = metrics.counter({
          name: 'events_published_total',
          help: 'Events published, by event type',
          labelNames: ['type'],
        });
        return new EventPublisher(
          redis,
          config.appEnv,
          loggingEventContext(logger, config.serviceName),
          (name) => published.inc({ type: name }),
        );
      },
    },
    {
      provide: EventSubscriber,
      inject: [REDIS, AppConfig, PinoLogger],
      useFactory: (redis: Redis, config: AppConfig, logger: PinoLogger) => {
        logger.setContext('EventSubscriber');
        const connection = createSubscriberRedis(redis);
        watchRedisConnection(connection, logger, 'subscriber');
        return new EventSubscriber(
          connection,
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
