import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import type { PinoLogger } from 'nestjs-pino';

// The library does not export this type from its index.
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

const WARN_INTERVAL_MS = 60_000;

const ALLOW: ThrottlerStorageRecord = {
  totalHits: 0,
  timeToExpire: 0,
  isBlocked: false,
  timeToBlockExpire: 0,
};

/**
 * Wraps the inner storage so that a broken limiter never takes the service down (fail open).
 * While Redis is not connected the inner storage is not called at all: ioredis would otherwise
 * hold every request for its command retries before failing.
 */
export class FailOpenThrottlerStorage implements ThrottlerStorage {
  private lastWarningAt: number | null = null;

  constructor(
    private readonly inner: ThrottlerStorage,
    private readonly redis: Redis,
    private readonly logger: PinoLogger,
    private readonly now: () => number = Date.now,
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    // 'wait' is lazyConnect before the first command: the call below connects.
    if (this.redis.status !== 'ready' && this.redis.status !== 'wait') {
      this.warn({ redisStatus: this.redis.status });
      return ALLOW;
    }
    try {
      return await this.inner.increment(key, ttl, limit, blockDuration, throttlerName);
    } catch (err) {
      this.warn({ redisStatus: this.redis.status, err });
      return ALLOW;
    }
  }

  private warn(fields: { redisStatus: string; err?: unknown }): void {
    const now = this.now();
    if (this.lastWarningAt !== null && now - this.lastWarningAt < WARN_INTERVAL_MS) return;
    this.lastWarningAt = now;
    this.logger.warn(fields, 'rate limiter unavailable, requests are not limited');
  }
}
