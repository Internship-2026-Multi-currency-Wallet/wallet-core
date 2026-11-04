import type { CookieOptions } from 'express';

export const REFRESH_TOKEN_COOKIE = 'refresh_token';

/**
 * Not readable by scripts, sent only to this API host (no `Domain`) and only with GraphQL calls.
 * `secure` is off for http://localhost, where not every browser keeps a Secure cookie.
 */
export function refreshTokenCookieOptions(secure: boolean, expiresAt: Date): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'strict', path: '/graphql', expires: expiresAt };
}
