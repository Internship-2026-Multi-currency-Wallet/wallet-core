import type { ConnectionOptions } from 'bullmq';
import { redisName } from '../events/event-bus.js';

/** BullMQ bundles its own ioredis, so the shared `REDIS` instance cannot be passed; build options from the URL. */
export function redisConnectionOptions(
  redisUrl: string,
  extra: { enableOfflineQueue?: boolean; maxRetriesPerRequest?: number | null } = {},
): ConnectionOptions {
  const url = new URL(redisUrl);
  const db = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined;
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    ...extra,
  };
}

/** BullMQ keys become `<APP_ENV>:email:*`; validated like the event helpers do. */
export function queuePrefix(appEnv: string): string {
  redisName(appEnv, 'email');
  return appEnv;
}
