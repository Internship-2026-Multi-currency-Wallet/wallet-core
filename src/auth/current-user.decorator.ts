import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthUser } from './auth-user.js';
import { getRequest } from './request-context.js';

/**
 * Injects the authenticated user into a resolver/controller method:
 *
 *   @Query(() => Balance)
 *   balance(@CurrentUser() user: AuthUser) { ... }
 *
 * On `@Public()` handlers the value is `undefined` for anonymous callers.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser | undefined => getRequest(context).user,
);
