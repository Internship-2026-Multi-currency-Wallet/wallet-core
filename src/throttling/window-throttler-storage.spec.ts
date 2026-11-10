import { jest } from '@jest/globals';
import type { Redis } from 'ioredis';
import { WindowThrottlerStorage } from './window-throttler-storage.js';

const KEY = 'staging:throttle:wallet-core:user:42';
const TTL_MS = 60_000;

function setup(reply: unknown) {
  const redis = { eval: jest.fn<(...args: unknown[]) => Promise<unknown>>() };
  redis.eval.mockResolvedValue(reply);
  const storage = new WindowThrottlerStorage(redis as unknown as Redis);
  return { redis, storage };
}

describe('WindowThrottlerStorage', () => {
  it('passes the key unchanged and the window in milliseconds to the script', async () => {
    const { redis, storage } = setup([1, 60_000]);

    await storage.increment(KEY, TTL_MS, 5, 0, 'default');

    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 1, KEY, '60000');
  });

  it('does not block when hits equal the limit', async () => {
    const { storage } = setup([5, 30_000]);

    await expect(storage.increment(KEY, TTL_MS, 5, 0, 'default')).resolves.toEqual({
      totalHits: 5,
      timeToExpire: 30,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it('blocks until the window ends when hits exceed the limit', async () => {
    const { storage } = setup([6, 30_000]);

    await expect(storage.increment(KEY, TTL_MS, 5, 0, 'default')).resolves.toEqual({
      totalHits: 6,
      timeToExpire: 30,
      isBlocked: true,
      timeToBlockExpire: 30,
    });
  });

  it('never reports a blocked record as expiring in 0 seconds', async () => {
    const { storage } = setup([6, 0]);

    await expect(storage.increment(KEY, TTL_MS, 5, 0, 'default')).resolves.toMatchObject({
      isBlocked: true,
      timeToExpire: 1,
      timeToBlockExpire: 1,
    });
  });

  it.each([
    [59_001, 60],
    [1, 1],
  ])('rounds the remaining %i ms up to %i s', async (pttl, seconds) => {
    const { storage } = setup([1, pttl]);

    const record = await storage.increment(KEY, TTL_MS, 5, 0, 'default');

    expect(record.timeToExpire).toBe(seconds);
  });

  it.each([['x'], [[1]], [['a', 1]]])('rejects a malformed reply %j', async (reply) => {
    const { storage } = setup(reply);

    await expect(storage.increment(KEY, TTL_MS, 5, 0, 'default')).rejects.toThrow(TypeError);
  });
});
