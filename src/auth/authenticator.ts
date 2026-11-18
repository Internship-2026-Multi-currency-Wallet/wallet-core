import { Inject, Injectable } from '@nestjs/common';
import { AUTH_STRATEGIES, type AuthStrategy } from './auth-strategy.js';
import type { AuthUser } from './auth-user.js';
import type { RequestLike } from './request-context.js';

/**
 * Runs the `AuthStrategy` list in order; the first one that returns a user wins. The result is kept
 * per request object, so the rate limit middleware and `AuthGuard` (once per top-level GraphQL
 * field) authenticate a request only once.
 */
@Injectable()
export class Authenticator {
  private readonly results = new WeakMap<RequestLike, Promise<AuthUser | null>>();

  constructor(@Inject(AUTH_STRATEGIES) private readonly strategies: AuthStrategy[]) {}

  /** Rejects with the strategy's error when the credentials are invalid. */
  authenticate(request: RequestLike): Promise<AuthUser | null> {
    let result = this.results.get(request);
    if (!result) {
      result = this.run(request);
      this.results.set(request, result);
    }
    return result;
  }

  private async run(request: RequestLike): Promise<AuthUser | null> {
    const header = request.headers.authorization;
    const authorization = Array.isArray(header) ? header[0] : header;
    for (const strategy of this.strategies) {
      const user = await strategy.authenticate({ authorization, headers: request.headers });
      if (user) return user;
    }
    return null;
  }
}
