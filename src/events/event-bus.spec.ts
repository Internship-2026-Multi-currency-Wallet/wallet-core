import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import type { RateTickEvent } from './catalog.js';
import {
  decodeStreamEntry,
  eventChannel,
  EventPublisher,
  eventStream,
  EventSubscriber,
  redisName,
} from './event-bus.js';

const tick: RateTickEvent = {
  v: 1,
  source: 'fake',
  base: 'USD',
  quote: 'UAH',
  bid: null,
  ask: null,
  mid: '41.5000',
  ts: '2026-01-01T00:00:00.000Z',
};

describe('EventPublisher', () => {
  it('publishes pub/sub events to their channel', async () => {
    const redis = { publish: jest.fn(() => Promise.resolve(1)), xadd: jest.fn() };
    const publisher = new EventPublisher(redis as unknown as Redis, 'kvitka-uat');

    await expect(publisher.publish('rate.tick', tick)).resolves.toBeNull();
    expect(redis.publish).toHaveBeenCalledWith('kvitka-uat:rate.tick', JSON.stringify(tick));
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('appends stream events with XADD and a capped length', async () => {
    const redis = { publish: jest.fn(), xadd: jest.fn(() => Promise.resolve('1-0')) };
    const publisher = new EventPublisher(redis as unknown as Redis, 'kvitka-uat');
    const event = {
      v: 1 as const,
      eventId: 'e1',
      conversionId: 'c1',
      client: 'demo',
      userId: 'u1',
      from: { currency: 'USD' as const, amount: '10000' },
      to: { currency: 'UAH' as const, amount: '415000' },
      rate: '41.5',
      midRate: '41.6',
      occurredAt: '2026-01-01T00:00:00.000Z',
    };

    await expect(publisher.publish('conversion.completed', event)).resolves.toBe('1-0');
    expect(redis.xadd).toHaveBeenCalledWith(
      'kvitka-uat:conversion.completed',
      'MAXLEN',
      '~',
      '100000',
      '*',
      'payload',
      JSON.stringify(event),
    );
    expect(decodeStreamEntry('conversion.completed', ['payload', JSON.stringify(event)])).toEqual(
      event,
    );
  });
});

describe('EventSubscriber', () => {
  function fakeConnection() {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      status: 'ready',
      subscribe: jest.fn(() => Promise.resolve(1)),
      unsubscribe: jest.fn(() => Promise.resolve(0)),
      quit: jest.fn(() => Promise.resolve('OK')),
      disconnect: jest.fn(),
    });
  }

  it('delivers parsed payloads to handlers and unsubscribes', async () => {
    const connection = fakeConnection();
    const subscriber = new EventSubscriber(connection as unknown as Redis, 'staging');
    const received: RateTickEvent[] = [];

    const off = await subscriber.subscribe('rate.tick', (payload) => {
      received.push(payload);
    });
    expect(connection.subscribe).toHaveBeenCalledWith('staging:rate.tick');

    connection.emit('message', 'staging:rate.tick', JSON.stringify(tick));
    connection.emit('message', 'rate.tick', JSON.stringify(tick)); // no prefix: another environment
    connection.emit('message', 'local:rate.tick', JSON.stringify(tick));
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toEqual([tick]);

    await off();
    expect(connection.unsubscribe).toHaveBeenCalledWith('staging:rate.tick');
  });

  it('reports bad messages and failing handlers to onError', async () => {
    const connection = fakeConnection();
    const onError = jest.fn();
    const subscriber = new EventSubscriber(connection as unknown as Redis, 'staging', onError);
    await subscriber.subscribe('rate.tick', () => {
      throw new Error('boom');
    });

    connection.emit('message', 'staging:rate.tick', 'not json');
    connection.emit('message', 'staging:rate.tick', JSON.stringify(tick));
    await new Promise((resolve) => setImmediate(resolve));
    expect(onError).toHaveBeenCalledTimes(2);
  });
});

describe('Redis names', () => {
  it('prefixes channels and streams with the environment', () => {
    expect(redisName('wisla-uat', 'x')).toBe('wisla-uat:x');
    expect(eventChannel('staging', 'rate.tick')).toBe('staging:rate.tick');
    expect(eventStream('kvitka-uat', 'conversion.completed')).toBe(
      'kvitka-uat:conversion.completed',
    );
  });

  it('rejects an empty or nested prefix', () => {
    expect(() => redisName('', 'rate.tick')).toThrow(/prefix/);
    expect(() => redisName('a:b', 'rate.tick')).toThrow(/prefix/);
  });
});
