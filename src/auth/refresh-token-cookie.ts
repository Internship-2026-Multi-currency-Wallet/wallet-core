import type { CookieOptions } from 'express';

export const REFRESH_TOKEN_COOKIE = 'refresh_token';

/**
 * No `Domain`, so the cookie reaches only this API host, not other environments on the same
 * domain. Some browsers drop a Secure cookie over http://localhost, so `secure` is off locally.
 */
export function refreshTokenCookieOptions(secure: boolean, expiresAt: Date): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'strict', path: '/graphql', expires: expiresAt };
}
