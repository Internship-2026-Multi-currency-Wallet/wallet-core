import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

// The library does not export this type from its index.
export type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

// One script: INCR and the expiry must not be separated, or a crash between them leaves a counter that never expires.
const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }
`;

type ThrottleRedis = Redis & {
  throttleIncrement(key: string, ttlMs: string): Promise<unknown>;
};

/** The refusal never outlasts the window, so `blockDuration` is ignored. */
export class WindowThrottlerStorage implements ThrottlerStorage {
  private readonly redis: ThrottleRedis;

  constructor(redis: Redis) {
    // A defined command runs as EVALSHA, so the script text is not sent with every request.
    redis.defineCommand('throttleIncrement', { numberOfKeys: 1, lua: INCREMENT_SCRIPT });
    this.redis = redis as ThrottleRedis;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    _blockDuration: number,
    _throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const reply: unknown = await this.redis.throttleIncrement(key, String(ttl));
    if (!Array.isArray(reply) || typeof reply[0] !== 'number' || typeof reply[1] !== 'number') {
      throw new TypeError('Unexpected reply from the rate limit script');
    }
    const [hits, pttl] = reply as [number, number];
    const isBlocked = hits > limit;
    const remaining = Math.ceil(pttl / 1000);
    // In the last millisecond PTTL can be 0, and `Retry-After: 0` would invite an immediate retry.
    const seconds = isBlocked ? Math.max(1, remaining) : remaining;
    return {
      totalHits: hits,
      timeToExpire: seconds,
      isBlocked,
      timeToBlockExpire: isBlocked ? seconds : 0,
    };
  }
}
