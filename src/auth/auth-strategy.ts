import type { AuthUser } from './auth-user.js';

/** What a strategy gets to look at. Same shape for HTTP, GraphQL and GraphQL websocket requests. */
export interface AuthRequest {
  /** Raw `Authorization` header (or `Authorization` websocket connection param). */
  authorization?: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * A way to turn request credentials into an `AuthUser`.
 *
 * - Return `null` when the request does not carry credentials this strategy understands
 *   (the guard then tries the next strategy).
 * - Throw `UnauthorizedException` when the credentials are meant for this strategy but are invalid
 *   (expired token, bad signature, malformed dev header).
 *
 * Register strategies in `AuthModule` under the `AUTH_STRATEGIES` token.
 * Business code never depends on a concrete strategy.
 */
export interface AuthStrategy {
  readonly name: string;
  authenticate(request: AuthRequest): Promise<AuthUser | null> | AuthUser | null;
}

/** Injection token: an ordered list of `AuthStrategy` instances. */
export const AUTH_STRATEGIES = Symbol('AUTH_STRATEGIES');
