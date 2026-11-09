import { jest } from '@jest/globals';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import type { PinoLogger } from 'nestjs-pino';
import { FailOpenThrottlerStorage } from './fail-open-storage.js';
import type { ThrottlerStorageRecord } from './window-throttler-storage.js';

const COUNTED: ThrottlerStorageRecord = {
  totalHits: 3,
  timeToExpire: 40,
  isBlocked: false,
  timeToBlockExpire: 0,
};
const ALLOWED: ThrottlerStorageRecord = {
  totalHits: 0,
  timeToExpire: 0,
  isBlocked: false,
  timeToBlockExpire: 0,
};

function setup(status: string) {
  const inner = { increment: jest.fn<ThrottlerStorage['increment']>() };
  inner.increment.mockResolvedValue(COUNTED);
  const redis = { status };
  const logger = { warn: jest.fn() };
  let time = 1_000_000;
  const storage = new FailOpenThrottlerStorage(
    inner,
    redis as unknown as Redis,
    logger as unknown as PinoLogger,
    () => time,
  );
  const increment = () => storage.increment('key', 60_000, 10, 60_000, 'default');
  return { inner, redis, logger, increment, advance: (ms: number) => (time += ms) };
}

describe('FailOpenThrottlerStorage', () => {
  it.each(['ready', 'wait'])('delegates to the inner storage when Redis is %s', async (status) => {
    const { inner, logger, increment } = setup(status);
    await expect(increment()).resolves.toBe(COUNTED);
    expect(inner.increment).toHaveBeenCalledWith('key', 60_000, 10, 60_000, 'default');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('allows the request without calling Redis while it is reconnecting', async () => {
    const { inner, logger, increment } = setup('reconnecting');
    await expect(increment()).resolves.toEqual(ALLOWED);
    expect(inner.increment).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { redisStatus: 'reconnecting' },
      'rate limiter unavailable, requests are not limited',
    );
  });

  it('allows the request and warns with the error when the inner storage fails', async () => {
    const { inner, logger, increment } = setup('ready');
    inner.increment.mockRejectedValue(new Error('connection reset'));
    await expect(increment()).resolves.toEqual(ALLOWED);
    expect(logger.warn).toHaveBeenCalledWith(
      { redisStatus: 'ready', err: { name: 'Error', message: 'connection reset' } },
      'rate limiter unavailable, requests are not limited',
    );
  });

  it('logs only the name and message of an error, not the command it carries', async () => {
    const { inner, logger, increment } = setup('ready');
    const err = Object.assign(new Error('READONLY'), {
      command: { name: 'eval', args: ['local hits = redis.call', 'prod:throttle:ip:203.0.113.5'] },
    });
    inner.increment.mockRejectedValue(err);
    await increment();
    expect(logger.warn).toHaveBeenCalledWith(
      { redisStatus: 'ready', err: { name: 'Error', message: 'READONLY' } },
      'rate limiter unavailable, requests are not limited',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('203.0.113.5');
  });

  it('logs a non-Error rejection as a string', async () => {
    const { inner, logger, increment } = setup('ready');
    inner.increment.mockRejectedValue('boom');
    await increment();
    expect(logger.warn).toHaveBeenCalledWith(
      { redisStatus: 'ready', err: 'boom' },
      'rate limiter unavailable, requests are not limited',
    );
  });

  describe('when the inner storage never answers', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('allows the request after 300 ms and warns once', async () => {
      const { inner, logger, increment } = setup('ready');
      inner.increment.mockReturnValue(new Promise<ThrottlerStorageRecord>(() => {}));
      const result = increment();
      await jest.advanceTimersByTimeAsync(299);
      expect(logger.warn).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toEqual(ALLOWED);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        { redisStatus: 'ready', err: { name: 'Error', message: 'rate limit storage timeout' } },
        'rate limiter unavailable, requests are not limited',
      );
    });

    it('leaves no timer behind when the inner storage answers in time', async () => {
      const { increment } = setup('ready');
      await expect(increment()).resolves.toBe(COUNTED);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('cooldown after a failure', () => {
    it('skips the inner storage for 10 seconds and calls it again afterwards', async () => {
      const { inner, increment, advance } = setup('ready');
      inner.increment.mockRejectedValueOnce(new Error('connection reset'));
      await increment();
      expect(inner.increment).toHaveBeenCalledTimes(1);

      advance(9_999);
      await expect(increment()).resolves.toEqual(ALLOWED);
      await expect(increment()).resolves.toEqual(ALLOWED);
      expect(inner.increment).toHaveBeenCalledTimes(1);

      advance(1);
      await expect(increment()).resolves.toBe(COUNTED);
      expect(inner.increment).toHaveBeenCalledTimes(2);
    });

    it('does not warn for requests skipped during the cooldown', async () => {
      const { inner, logger, increment, advance } = setup('ready');
      inner.increment.mockRejectedValueOnce(new Error('connection reset'));
      await increment();
      advance(5_000);
      await increment();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('starts a new cooldown when the call after the previous one fails again', async () => {
      const { inner, increment, advance } = setup('ready');
      inner.increment.mockRejectedValue(new Error('connection reset'));
      await increment();
      advance(10_000);
      await increment();
      expect(inner.increment).toHaveBeenCalledTimes(2);
      advance(9_999);
      await increment();
      expect(inner.increment).toHaveBeenCalledTimes(2);
    });

    it('applies after a timeout too', async () => {
      jest.useFakeTimers();
      try {
        const { inner, increment, advance } = setup('ready');
        inner.increment.mockReturnValueOnce(new Promise<ThrottlerStorageRecord>(() => {}));
        const first = increment();
        await jest.advanceTimersByTimeAsync(300);
        await expect(first).resolves.toEqual(ALLOWED);

        advance(5_000);
        await expect(increment()).resolves.toEqual(ALLOWED);
        expect(inner.increment).toHaveBeenCalledTimes(1);

        advance(5_000);
        await expect(increment()).resolves.toBe(COUNTED);
        expect(inner.increment).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('never opens after successful calls', async () => {
      const { inner, increment, advance } = setup('ready');
      await increment();
      advance(1);
      await increment();
      await increment();
      expect(inner.increment).toHaveBeenCalledTimes(3);
    });
  });

  it('warns at most once per minute', async () => {
    const { logger, increment, advance } = setup('end');
    await increment();
    advance(59_000);
    await increment();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    advance(1_000);
    await increment();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
