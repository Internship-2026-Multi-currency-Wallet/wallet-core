import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Redis } from 'ioredis';
import { closeRedis } from '../src/redis/redis-connection.js';
import { createRedis } from '../src/redis/redis.module.js';
import { WindowThrottlerStorage } from '../src/throttling/window-throttler-storage.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('WindowThrottlerStorage (e2e, real Redis)', () => {
  let redis: Redis;
  let storage: WindowThrottlerStorage;
  // A dedicated prefix keeps test counters away from a running local stack.
  const newKey = (): string => `e2e:throttle:${randomUUID()}`;

  beforeAll(async () => {
    redis = createRedis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    storage = new WindowThrottlerStorage(redis);
    // The command client has no offline queue: a command sent before it is ready fails at once.
    // `once` rejects on the first connection error or the deadline and removes its listeners.
    try {
      if (redis.status !== 'ready') {
        await once(redis, 'ready', { signal: AbortSignal.timeout(10_000) });
      }
    } catch (error) {
      redis.disconnect(); // stop reconnecting; the setup error is the one to report
      throw error;
    }
  });

  afterAll(async () => {
    await closeRedis(redis);
  });

  it('counts hits in the window and blocks once the limit is exceeded', async () => {
    const key = newKey();

    const hits: number[] = [];
    for (let i = 0; i < 3; i++) {
      const record = await storage.increment(key, 60_000, 3, 0, 'default');
      expect(record.isBlocked).toBe(false);
      hits.push(record.totalHits);
    }
    const fourth = await storage.increment(key, 60_000, 3, 0, 'default');

    expect(hits).toEqual([1, 2, 3]);
    expect(fourth.totalHits).toBe(4);
    expect(fourth.isBlocked).toBe(true);
  });

  it('ends the refusal with the window, not later', async () => {
    const key = newKey();

    await storage.increment(key, 1000, 1, 0, 'default');
    // Hit mid-window: a block counted from this hit (not the window) would still refuse the third call.
    await sleep(600);
    const refused = await storage.increment(key, 1000, 1, 0, 'default');
    await sleep(450);
    const afterWindow = await storage.increment(key, 1000, 1, 0, 'default');

    expect(refused.isBlocked).toBe(true);
    expect(refused.timeToBlockExpire).toBe(1);
    expect(afterWindow.isBlocked).toBe(false);
    expect(afterWindow.totalHits).toBe(1);
  });

  it('reports a block time that never exceeds the window', async () => {
    const key = newKey();

    await storage.increment(key, 60_000, 1, 0, 'default');
    const refused = await storage.increment(key, 60_000, 1, 0, 'default');

    expect(refused.isBlocked).toBe(true);
    expect(refused.timeToBlockExpire).toBeGreaterThan(0);
    expect(refused.timeToBlockExpire).toBeLessThanOrEqual(60);
  });
});
