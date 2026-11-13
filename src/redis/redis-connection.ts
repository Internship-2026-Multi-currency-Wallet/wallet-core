import type { Redis, RedisOptions } from 'ioredis';
import type { PinoLogger } from 'nestjs-pino';

export const REDIS_COMMAND_TIMEOUT_MS = 2000;

/**
 * Request client: connects at startup in the background and has no offline queue, so a command
 * issued while Redis is down fails at once and is never sent later.
 */
export const COMMAND_CLIENT_OPTIONS: RedisOptions = {
  // Bound retries for pending commands after a connection loss.
  maxRetriesPerRequest: 3,
  commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
  enableOfflineQueue: false,
};

/**
 * Pub/sub client: keeps SUBSCRIBE queued until Redis is reachable; ioredis resubscribes after
 * reconnects.
 */
export const SUBSCRIBER_CLIENT_OPTIONS: RedisOptions = {
  enableOfflineQueue: true,
  maxRetriesPerRequest: null,
  commandTimeout: undefined,
  autoResubscribe: true,
};

/** Only log error identifiers because Redis error messages may contain host information. */
export function redisErrorReason(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const { code, name, message } = error as { code?: unknown; name?: unknown; message?: unknown };
    if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code;
    if (name === 'ReplyError' && typeof message === 'string') {
      const word = message.split(' ', 1)[0];
      if (/^[A-Z]+$/.test(word)) return word;
    }
    if (typeof name === 'string' && /^\w+$/.test(name)) return name;
  }
  return 'unknown';
}

/**
 * One warning per outage, on `reconnecting`, which ioredis does not emit for QUIT or
 * `disconnect()`.
 */
export function watchRedisConnection(
  redis: Redis,
  logger: PinoLogger,
  connection: 'command' | 'subscriber',
): void {
  let down = false;
  let reason = 'CLOSED';
  redis.on('error', (error: unknown) => {
    reason = redisErrorReason(error);
    logger.debug({ connection, reason }, 'Redis connection error');
  });
  redis.on('reconnecting', () => {
    if (down) return;
    down = true;
    logger.warn({ connection, reason }, 'Redis unavailable, reconnecting with backoff');
  });
  redis.on('ready', () => {
    reason = 'CLOSED';
    if (!down) return;
    down = false;
    logger.info({ connection }, 'Redis connection restored');
  });
}

export async function closeRedis(redis: Redis, timeoutMs = 1000): Promise<void> {
  if (redis.status !== 'ready') {
    redis.disconnect();
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      redis.quit(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
  } catch {
    redis.disconnect();
  } finally {
    clearTimeout(timer);
  }
}
