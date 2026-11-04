import type { CookieOptions } from 'express';

export const REFRESH_TOKEN_COOKIE = 'refresh_token';

/**
 * Omit Domain to restrict delivery to this host, and disable Secure locally for browsers that
 * reject secure cookies over localhost HTTP.
 */
export function refreshTokenCookieOptions(secure: boolean, expiresAt: Date): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'strict', path: '/graphql', expires: expiresAt };
}
