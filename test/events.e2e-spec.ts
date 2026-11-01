import { Redis } from 'ioredis';
import type { ConversionCompletedEvent, RateTickEvent } from '../src/events/catalog.js';
import {
  decodeStreamEntry,
  EventPublisher,
  eventStream,
  EventSubscriber,
} from '../src/events/event-bus.js';

describe('event bus (e2e, real Redis)', () => {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  // A dedicated environment prefix keeps test events away from a running local stack.
  const prefix = 'e2e';
  let redis: Redis;
  let subscriber: EventSubscriber;

  beforeAll(() => {
    redis = new Redis(url);
    subscriber = new EventSubscriber(new Redis(url), prefix);
  });

  afterAll(async () => {
    await subscriber.close();
    await redis.quit();
  });

  it('delivers rate.tick over pub/sub', async () => {
    const tick: RateTickEvent = {
      v: 1,
      source: 'e2e',
      base: 'USD',
      quote: 'UAH',
      bid: '41.40',
      ask: '41.60',
      mid: '41.50',
      ts: new Date().toISOString(),
    };
    const received = new Promise<RateTickEvent>((resolve) => {
      void subscriber.subscribe('rate.tick', resolve);
    });
    // A tick published by another environment must not arrive.
    const other = new Promise<'none' | RateTickEvent>((resolve) => {
      const otherEnv = new EventSubscriber(new Redis(url), 'e2e-other');
      void otherEnv.subscribe('rate.tick', resolve);
      setTimeout(() => void otherEnv.close().then(() => resolve('none')), 500);
    });
    // Give SUBSCRIBE a moment to reach Redis before publishing.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await new EventPublisher(redis, prefix).publish('rate.tick', tick);
    await expect(received).resolves.toEqual(tick);
    await expect(other).resolves.toBe('none');
  });

  it('appends conversion.completed to its stream', async () => {
    const event: ConversionCompletedEvent = {
      v: 1,
      eventId: `e2e-${Date.now()}`,
      conversionId: 'c1',
      client: 'demo',
      userId: '1',
      from: { currency: 'USD', amount: '10000' },
      to: { currency: 'UAH', amount: '415000' },
      rate: '41.5',
      midRate: '41.6',
      occurredAt: new Date().toISOString(),
    };
    const id = await new EventPublisher(redis, prefix).publish('conversion.completed', event);
    expect(id).toEqual(expect.any(String));

    const entries = await redis.xrange(eventStream(prefix, 'conversion.completed'), id!, id!);
    expect(decodeStreamEntry('conversion.completed', entries[0][1])).toEqual(event);
  });
});
