import { jest } from '@jest/globals';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import type { PinoLogger } from 'nestjs-pino';
import { FailOpenThrottlerStorage } from './fail-open-storage.js';

type StorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

const COUNTED: StorageRecord = {
  totalHits: 3,
  timeToExpire: 40,
  isBlocked: false,
  timeToBlockExpire: 0,
};
const ALLOWED: StorageRecord = {
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
    const err = new Error('connection reset');
    inner.increment.mockRejectedValue(err);
    await expect(increment()).resolves.toEqual(ALLOWED);
    expect(logger.warn).toHaveBeenCalledWith(
      { redisStatus: 'ready', err },
      'rate limiter unavailable, requests are not limited',
    );
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
