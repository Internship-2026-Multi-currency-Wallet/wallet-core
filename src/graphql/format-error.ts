import { unwrapResolverError } from '@apollo/server/errors';
import { HttpException } from '@nestjs/common';
import {
  type ExecutionResult,
  type FormattedExecutionResult,
  GraphQLError,
  type GraphQLFormattedError,
} from 'graphql';

export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

/**
 * Apollo `formatError`: hides unexpected errors from the client. Errors thrown on purpose (a
 * `GraphQLError` with a code, or a Nest `HttpException`) pass unchanged; anything else (a database
 * error, a bug) becomes a bare `INTERNAL_SERVER_ERROR`, because its message can carry SQL or
 * internals. A `GraphQLError` without a code is unexpected too: GraphQL itself throws one when a
 * resolver returns a wrong value, with that value in the message. The original is still logged by
 * `graphqlLoggingPlugin`, which runs first.
 */
export function formatError(
  formatted: GraphQLFormattedError,
  error: unknown,
): GraphQLFormattedError {
  const original = unwrapResolverError(error);
  if (original instanceof HttpException) return formatted;
  if (original instanceof GraphQLError && typeof original.extensions.code === 'string') {
    return formatted;
  }
  return {
    message: INTERNAL_ERROR_MESSAGE,
    locations: formatted.locations,
    path: formatted.path,
    extensions: { code: 'INTERNAL_SERVER_ERROR' },
  };
}

/**
 * graphql-ws `onNext`: the same masking for results sent over the websocket (any operation can go
 * there, not only subscriptions), which Apollo's `formatError` does not see. Returning nothing
 * sends the result unchanged.
 */
export function formatExecutionResult(
  result: ExecutionResult,
): FormattedExecutionResult | undefined {
  if (!result.errors) return undefined;
  return { ...result, errors: result.errors.map((error) => formatError(error.toJSON(), error)) };
}
