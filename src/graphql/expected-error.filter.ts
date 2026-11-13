import { type ArgumentsHost, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { GqlContextType } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';

/**
 * Thrown on purpose: a `GraphQLError` with a string code. Classify the original error, not a
 * transport wrapper or formatted error, whose code may be copied or added.
 */
export function isExpectedGraphqlError(original: unknown): original is GraphQLError {
  return original instanceof GraphQLError && typeof original.extensions.code === 'string';
}

/**
 * Keeps Nest's `ExceptionsHandler` from logging expected GraphQL errors at ERROR: the GraphQL
 * logging does it at warn (`graphqlLoggingPlugin` over HTTP, `logWsErrors` over graphql-ws).
 */
@Catch(GraphQLError)
export class ExpectedGraphqlErrorFilter extends BaseExceptionFilter {
  override catch(exception: GraphQLError, host: ArgumentsHost): unknown {
    // A global filter also sees HTTP routes, where returning would leave the request unanswered.
    if (host.getType<GqlContextType>() !== 'graphql') return super.catch(exception, host);
    // Rethrowing skips Nest's log. `undefined` means "not handled" to Nest's
    // ExternalExceptionsHandler: it logs ERROR with the stack and rethrows, as without this filter.
    if (isExpectedGraphqlError(exception)) throw exception;
    return undefined;
  }
}
