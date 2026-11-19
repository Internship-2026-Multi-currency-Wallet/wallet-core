import { normalizeIp } from '@nestjs/throttler';
import type { AuthUser } from '../auth/auth-user.js';
import { UserKind } from '../auth/user-kind.js';
import type { AppConfig } from '../config/app-config.js';

function keyType(user: AuthUser): 'staff' | 'user' {
  return user.kind === UserKind.STAFF ? 'staff' : 'user';
}

export function throttleTracker(user: AuthUser | undefined, ip: string | undefined): string {
  return user ? `${keyType(user)}:${user.id}` : `ip:${normalizeIp(ip ?? '')}`;
}

export function throttleLimit(config: AppConfig, user: AuthUser | undefined): number {
  return user ? config.throttle.limitUser : config.throttle.limitAnonymous;
}

// No handler name, so all endpoints share one counter; the service name separates backends sharing one Redis.
export function throttleKey(config: AppConfig, tracker: string): string {
  return `${config.appEnv}:throttle:${config.serviceName}:${tracker}`;
}

export function throttledCallerFields(
  user: AuthUser | undefined,
  ip: string | undefined,
): { keyType: 'staff' | 'user'; userId: string } | { keyType: 'ip'; ip: string | undefined } {
  return user ? { keyType: keyType(user), userId: user.id } : { keyType: 'ip', ip };
}
