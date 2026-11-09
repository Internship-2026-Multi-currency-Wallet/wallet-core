import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { createRedis } from '../src/redis/redis.module.js';
import { WindowThrottlerStorage } from '../src/throttling/window-throttler-storage.js';

/** The Lua script and the window semantics against a real Redis. */
describe('WindowThrottlerStorage (e2e, real Redis)', () => {
  let redis: Redis;
  let storage: WindowThrottlerStorage;
  // A dedicated prefix keeps test counters away from a running local stack.
  const newKey = (): string => `e2e:throttle:${randomUUID()}`;

  beforeAll(() => {
    redis = createRedis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    storage = new WindowThrottlerStorage(redis);
  });

  afterAll(async () => {
    await redis.quit();
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
    const refused = await storage.increment(key, 1000, 1, 0, 'default');
    await new Promise((resolve) => setTimeout(resolve, 1100));
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
