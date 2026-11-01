import type { ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { AuthUser } from './auth-user.js';

/** The object the guards read headers from and store the user on (an Express request, or a fake one for websockets). */
export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthUser;
}

/** Returns the request object for HTTP and GraphQL (incl. subscriptions over websocket). */
export function getRequest(context: ExecutionContext): RequestLike {
  if (context.getType<string>() === 'graphql') {
    const gqlContext = GqlExecutionContext.create(context).getContext<{ req: RequestLike }>();
    return gqlContext.req;
  }
  return context.switchToHttp().getRequest<RequestLike>();
}

/**
 * Turns graphql-ws `connectionParams` into a request-like object, so the same guards work for
 * subscriptions. Clients send `{ Authorization: 'Dev 1:wallet' }` (any key casing).
 */
export function requestFromConnectionParams(
  params: Record<string, unknown> | undefined,
): RequestLike {
  const headers: RequestLike['headers'] = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value === 'string') headers[key.toLowerCase()] = value;
  }
  return { headers };
}
