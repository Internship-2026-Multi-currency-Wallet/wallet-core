import { unwrapResolverError } from '@apollo/server/errors';
import { HttpException } from '@nestjs/common';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';

export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

/**
 * Apollo `formatError`: hides unexpected errors from the client. Errors thrown on purpose (a
 * `GraphQLError` with a code, or a Nest `HttpException`) pass unchanged; anything else (a database
 * error, a bug) becomes a bare `INTERNAL_SERVER_ERROR`, because its message can carry SQL or
 * internals. The original is still logged in full by `graphqlLoggingPlugin`, which runs first.
 */
export function formatError(
  formatted: GraphQLFormattedError,
  error: unknown,
): GraphQLFormattedError {
  const original = unwrapResolverError(error);
  if (original instanceof GraphQLError || original instanceof HttpException) return formatted;
  return {
    message: INTERNAL_ERROR_MESSAGE,
    locations: formatted.locations,
    path: formatted.path,
    extensions: { code: 'INTERNAL_SERVER_ERROR' },
  };
}
