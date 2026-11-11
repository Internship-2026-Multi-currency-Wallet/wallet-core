import { parseCookie } from 'cookie';
import type { CookieOptions, Response } from 'express';
import type { RequestLike } from './request-context.js';

export const REFRESH_TOKEN_COOKIE = 'refresh_token';
export const STAFF_REFRESH_TOKEN_COOKIE = 'staff_refresh_token';

/**
 * Omit Domain to restrict delivery to this host, and disable Secure locally for browsers that
 * reject secure cookies over localhost HTTP.
 */
function cookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'strict', path: '/graphql' };
}

export function setRefreshTokenCookie(
  res: Response,
  token: string,
  expiresAt: Date,
  secure: boolean,
  name = REFRESH_TOKEN_COOKIE,
): void {
  res.cookie(name, token, { ...cookieOptions(secure), expires: expiresAt });
}

// Clearing must target the same cookie name, domain, and path.
export function clearRefreshTokenCookie(
  res: Response,
  secure: boolean,
  name = REFRESH_TOKEN_COOKIE,
): void {
  res.clearCookie(name, cookieOptions(secure));
}

export function readRefreshToken(
  req: RequestLike,
  name = REFRESH_TOKEN_COOKIE,
): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  return parseCookie(header)[name] || undefined;
}
