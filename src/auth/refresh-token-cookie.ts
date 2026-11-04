import { parseCookie } from 'cookie';
import type { CookieOptions, Response } from 'express';
import type { RequestLike } from './request-context.js';

export const REFRESH_TOKEN_COOKIE = 'refresh_token';

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
): void {
  res.cookie(REFRESH_TOKEN_COOKIE, token, { ...cookieOptions(secure), expires: expiresAt });
}

// Clearing must target the same cookie name, domain, and path.
export function clearRefreshTokenCookie(res: Response, secure: boolean): void {
  res.clearCookie(REFRESH_TOKEN_COOKIE, cookieOptions(secure));
}

export function readRefreshToken(req: RequestLike): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  return parseCookie(header)[REFRESH_TOKEN_COOKIE] || undefined;
}
