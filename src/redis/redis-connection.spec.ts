import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { Redis } from 'ioredis';
import type { PinoLogger } from 'nestjs-pino';
import {
  closeRedis,
  COMMAND_CLIENT_OPTIONS,
  redisErrorReason,
  REDIS_COMMAND_TIMEOUT_MS,
  SUBSCRIBER_CLIENT_OPTIONS,
  watchRedisConnection,
} from './redis-connection.js';
import { createRedis, createSubscriberRedis } from './redis.module.js';

function fakeLogger() {
  return { warn: jest.fn(), debug: jest.fn(), info: jest.fn() };
}

describe('Redis client options', () => {
  it('command client fails fast; subscriber client keeps commands queued', () => {
    const redis = createRedis('redis://127.0.0.1:1');
    const subscriber = createSubscriberRedis(redis);
    try {
      expect(redis.options).toMatchObject({
        lazyConnect: false,
        maxRetriesPerRequest: 3,
        commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
        enableOfflineQueue: false,
      });
      expect(subscriber.options.enableOfflineQueue).toBe(true);
      expect(subscriber.options.maxRetriesPerRequest).toBeNull();
      expect(subscriber.options.commandTimeout).toBeUndefined();
      expect(subscriber.options.autoResubscribe).toBe(true);
      // Both reconnect forever with the ioredis exponential backoff.
      for (const client of [redis, subscriber]) {
        const strategy = client.options.retryStrategy!;
        const first = strategy(1) as number;
        const late = strategy(30) as number;
        expect(first).toBeLessThan(300);
        expect(late).toBeGreaterThanOrEqual(5000);
        expect(late).toBeLessThan(5300);
      }
    } finally {
      redis.disconnect();
      subscriber.disconnect();
    }
    expect(COMMAND_CLIENT_OPTIONS).not.toBe(SUBSCRIBER_CLIENT_OPTIONS);
  });
});

describe('redisErrorReason', () => {
  it('returns a safe code, never the message', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:6379'), {
      code: 'ECONNREFUSED',
    });
    expect(redisErrorReason(refused)).toBe('ECONNREFUSED');
    const reply = Object.assign(new Error('WRONGPASS invalid username-password pair'), {
      name: 'ReplyError',
    });
    expect(redisErrorReason(reply)).toBe('WRONGPASS');
    const retries = Object.assign(new Error('Reached the max retries per request limit'), {
      name: 'MaxRetriesPerRequestError',
    });
    expect(redisErrorReason(retries)).toBe('MaxRetriesPerRequestError');
    expect(redisErrorReason('redis://user:secret@host')).toBe('unknown');
  });
});

describe('watchRedisConnection', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:16379'), {
    code: 'ECONNREFUSED',
  });

  function watched() {
    const redis = new EventEmitter();
    const logger = fakeLogger();
    watchRedisConnection(redis as unknown as Redis, logger as unknown as PinoLogger, 'subscriber');
    return { redis, logger };
  }

  it('warns when a connection closes and reconnects without any error', () => {
    const { redis, logger } = watched();
    redis.emit('ready');
    redis.emit('reconnecting', 50); // e.g. Redis restarted and closed the socket gracefully
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { connection: 'subscriber', reason: 'CLOSED' },
      expect.any(String),
    );
  });

  it('warns once per outage with the safe reason of the preceding error', () => {
    const { redis, logger } = watched();
    redis.emit('error', refused);
    redis.emit('reconnecting', 50);
    redis.emit('error', refused);
    redis.emit('reconnecting', 100);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { connection: 'subscriber', reason: 'ECONNREFUSED' },
      expect.any(String),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('127.0.0.1');
  });

  it('logs recovery once and warns again on the next outage', () => {
    const { redis, logger } = watched();
    redis.emit('ready'); // first connect: nothing to report
    expect(logger.info).not.toHaveBeenCalled();
    redis.emit('error', refused);
    redis.emit('reconnecting', 50);
    redis.emit('ready');
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith({ connection: 'subscriber' }, expect.any(String));
    redis.emit('reconnecting', 50);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenLastCalledWith(
      { connection: 'subscriber', reason: 'CLOSED' }, // the earlier error does not leak into it
      expect.any(String),
    );
  });

  it('real ioredis: a socket dropped without an error is reported as an outage', async () => {
    const sockets: Socket[] = [];
    const server = createServer((socket) => sockets.push(socket)); // accepts, never answers
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    // Short disconnectTimeout: the stream is already closed, so ioredis would wait its full 2 s.
    const redis = new Redis({
      port,
      host: '127.0.0.1',
      retryStrategy: () => 60_000,
      disconnectTimeout: 10,
    });
    const logger = fakeLogger();
    watchRedisConnection(redis, logger as unknown as PinoLogger, 'command');
    try {
      while (sockets.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      const reconnecting = new Promise((resolve) => redis.once('reconnecting', resolve));
      sockets[0].end(); // graceful FIN, as Redis does when it shuts down
      await reconnecting;
      expect(logger.warn).toHaveBeenCalledWith(
        { connection: 'command', reason: 'CLOSED' },
        expect.any(String),
      );
    } finally {
      redis.disconnect();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('closeRedis', () => {
  it('disconnects without QUIT when not ready', async () => {
    const redis = { status: 'reconnecting', quit: jest.fn(), disconnect: jest.fn() };
    await closeRedis(redis as unknown as Redis);
    expect(redis.quit).not.toHaveBeenCalled();
    expect(redis.disconnect).toHaveBeenCalled();
  });

  it('falls back to disconnect when QUIT does not answer in time', async () => {
    const redis = {
      status: 'ready',
      quit: jest.fn(() => new Promise(() => undefined)),
      disconnect: jest.fn(),
    };
    await closeRedis(redis as unknown as Redis, 10);
    expect(redis.disconnect).toHaveBeenCalled();
  });

  it('quits gracefully when ready', async () => {
    const redis = {
      status: 'ready',
      quit: jest.fn(() => Promise.resolve('OK')),
      disconnect: jest.fn(),
    };
    await closeRedis(redis as unknown as Redis);
    expect(redis.quit).toHaveBeenCalled();
    expect(redis.disconnect).not.toHaveBeenCalled();
  });
});
