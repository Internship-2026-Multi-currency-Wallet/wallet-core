import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

// The library does not export this type from its index.
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

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

/**
 * Fixed-window counter in Redis: the first hit starts the window, and once the limit is exceeded
 * requests are refused until the window ends. `blockDuration` and `throttlerName` are ignored on
 * purpose: the window itself is the block, so the refusal never outlasts it.
 */
export class WindowThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    _blockDuration: number,
    _throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const reply: unknown = await this.redis.eval(INCREMENT_SCRIPT, 1, key, String(ttl));
    if (!Array.isArray(reply) || typeof reply[0] !== 'number' || typeof reply[1] !== 'number') {
      throw new TypeError('Unexpected reply from the rate limit script');
    }
    const [hits, pttl] = reply as [number, number];
    const seconds = Math.ceil(pttl / 1000);
    const isBlocked = hits > limit;
    return {
      totalHits: hits,
      timeToExpire: seconds,
      isBlocked,
      timeToBlockExpire: isBlocked ? seconds : 0,
    };
  }
}
