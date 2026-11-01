import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTH_STRATEGIES, type AuthStrategy } from './auth-strategy.js';
import type { AuthUser } from './auth-user.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { getRequest } from './request-context.js';

/**
 * Global guard. Asks each registered `AuthStrategy` in order; the first one that returns a user wins.
 * Without a user the request is rejected with 401, unless the handler is `@Public()`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_STRATEGIES) private readonly strategies: AuthStrategy[],
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = getRequest(context);
    const authorization = firstHeader(request.headers.authorization);

    let user: AuthUser | null = null;
    try {
      for (const strategy of this.strategies) {
        user = await strategy.authenticate({ authorization, headers: request.headers });
        if (user) break;
      }
    } catch (error) {
      if (isPublic) return true; // bad credentials on a public endpoint: treat as anonymous
      throw error;
    }

    if (user) {
      request.user = user;
      return true;
    }
    if (isPublic) return true;
    throw new UnauthorizedException('Authentication required');
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
