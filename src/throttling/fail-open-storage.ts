import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import type { PinoLogger } from 'nestjs-pino';
import type { ThrottlerStorageRecord } from './window-throttler-storage.js';

const WARN_INTERVAL_MS = 60_000;
// A timed-out command is not cancelled, so without a pause new ones would pile up on the shared ioredis client.
const COOLDOWN_MS = 10_000;
// ioredis has no command timeout and a frozen connection keeps status `ready`, so without this every request would hang.
const STORAGE_TIMEOUT_MS = 300;

const ALLOW: ThrottlerStorageRecord = {
  totalHits: 0,
  timeToExpire: 0,
  isBlocked: false,
  timeToBlockExpire: 0,
};

type LoggableError = { name: string; message: string };

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('rate limit storage timeout')), STORAGE_TIMEOUT_MS);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ioredis reply errors carry `command.args` (the Lua script and a key with a client IP): log only name and message.
function loggableError(err: unknown): LoggableError | string {
  return err instanceof Error ? { name: err.name, message: err.message } : String(err);
}

/** A broken or stuck limiter must never take the service down, so every failure lets the request through. */
export class FailOpenThrottlerStorage implements ThrottlerStorage {
  private lastWarningAt: number | null = null;
  private skipRedisUntil = 0;

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
    if (this.now() < this.skipRedisUntil) return ALLOW;
    // While disconnected ioredis would hold the request for its command retries; 'wait' (lazyConnect) is fine because the call connects.
    if (this.redis.status !== 'ready' && this.redis.status !== 'wait') {
      this.warn({ redisStatus: this.redis.status });
      return ALLOW;
    }
    try {
      return await withTimeout(this.inner.increment(key, ttl, limit, blockDuration, throttlerName));
    } catch (err) {
      this.skipRedisUntil = this.now() + COOLDOWN_MS;
      this.warn({ redisStatus: this.redis.status, err: loggableError(err) });
      return ALLOW;
    }
  }

  private warn(fields: { redisStatus: string; err?: LoggableError | string }): void {
    const now = this.now();
    if (this.lastWarningAt !== null && now - this.lastWarningAt < WARN_INTERVAL_MS) return;
    this.lastWarningAt = now;
    this.logger.warn(fields, 'rate limiter unavailable, requests are not limited');
  }
}
