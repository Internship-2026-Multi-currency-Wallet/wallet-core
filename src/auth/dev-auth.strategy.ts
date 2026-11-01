import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthRequest, AuthStrategy } from './auth-strategy.js';
import type { AuthUser } from './auth-user.js';

const DEV_SCHEME = /^Dev\s+(.+)$/i;

/**
 * Development-only strategy, enabled with `DEV_AUTH=true`.
 *
 *   Authorization: Dev <userId>:<perm1,perm2>
 *
 * Examples: `Dev 1:wallet`, `Dev 42:bo:users,bo:users:modify`, `Dev 7` (no permissions).
 * The first `:` separates the user id from the permission list.
 */
@Injectable()
export class DevAuthStrategy implements AuthStrategy {
  readonly name = 'dev';

  authenticate({ authorization }: AuthRequest): AuthUser | null {
    if (!authorization) return null;
    const match = DEV_SCHEME.exec(authorization.trim());
    if (!match) return null;
    return parseDevCredentials(match[1]);
  }
}

export function parseDevCredentials(credentials: string): AuthUser {
  const separator = credentials.indexOf(':');
  const id = (separator === -1 ? credentials : credentials.slice(0, separator)).trim();
  const rawPermissions = separator === -1 ? '' : credentials.slice(separator + 1);
  if (!id || /\s/.test(id)) {
    throw new UnauthorizedException(
      'Malformed dev credentials. Expected "Dev <userId>:<perm1,perm2>"',
    );
  }
  const permissions = rawPermissions
    .split(',')
    .map((permission) => permission.trim())
    .filter(Boolean);
  return { id, permissions: [...new Set(permissions)], strategy: 'dev' };
}
