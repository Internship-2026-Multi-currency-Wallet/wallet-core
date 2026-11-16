import { unwrapResolverError } from '@apollo/server/errors';
import { HttpException } from '@nestjs/common';
import type {
  ExecutionResult,
  FormattedExecutionResult,
  GraphQLError,
  GraphQLFormattedError,
} from 'graphql';
import { isExpectedGraphqlError } from './expected-error.filter.js';

export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

/**
 * The code of a Nest `HttpException` by its status, the same over http and graphql-ws. Set here,
 * not left to `@nestjs/apollo`: it maps only 400/401/403/422 (a 404 stays INTERNAL_SERVER_ERROR)
 * and only over http, so a guard's denial would reach a websocket client with no code.
 */
const HTTP_STATUS_CODES: Partial<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  422: 'BAD_USER_INPUT',
};

/**
 * Apollo `formatError`: hides unexpected errors from the client. The original error is found with
 * `unwrapResolverError`, never from the formatted code, which `@nestjs/apollo` and Apollo may
 * already have changed. Errors thrown on purpose pass: a `GraphQLError` with a code as formatted, a
 * Nest `HttpException` with the code of its status (`HTTP_STATUS_CODES`). Anything else
 * (a database error, a bug) becomes a bare `INTERNAL_SERVER_ERROR`, because its message can carry
 * SQL or internals. A `GraphQLError` without a code is unexpected too: GraphQL itself throws one
 * when a resolver returns a wrong value, with that value in the message. Over HTTP the original is
 * still logged by `graphqlLoggingPlugin`, which runs first.
 */
export function formatError(
  formatted: GraphQLFormattedError,
  error: unknown,
): GraphQLFormattedError {
  return formatOriginal(formatted, unwrapResolverError(error));
}

/** Not unwrapped again: an intentionally thrown GraphQLError can itself have a path and cause. */
function formatOriginal(
  formatted: GraphQLFormattedError,
  original: unknown,
): GraphQLFormattedError {
  if (original instanceof HttpException) {
    const code = HTTP_STATUS_CODES[original.getStatus()];
    return code ? withCode(formatted, code) : formatted;
  }
  if (isExpectedGraphqlError(original)) return formatted;
  return {
    message: INTERNAL_ERROR_MESSAGE,
    locations: formatted.locations,
    path: formatted.path,
    extensions: { code: 'INTERNAL_SERVER_ERROR' },
  };
}

function withCode(formatted: GraphQLFormattedError, code: string): GraphQLFormattedError {
  return { ...formatted, extensions: { ...formatted.extensions, code } };
}

/**
 * graphql-ws `onNext`: the same `formatError` (codes and masking) for results sent over the
 * websocket (any operation can go there, not only subscriptions), which Apollo's `formatError`
 * does not see. Returning nothing sends the result unchanged. Pathless errors are variable
 * coercion failures, caused by the client: their explanation is kept.
 */
export function formatExecutionResult(
  result: ExecutionResult,
): FormattedExecutionResult | undefined {
  if (!result.errors) return undefined;
  return {
    ...result,
    errors: result.errors.map((error) =>
      error.path !== undefined ? formatError(error.toJSON(), error) : validationFailed(error),
    ),
  };
}

/** Keeps a string code, e.g. from a custom scalar that rejects the value with its own code. */
function validationFailed(error: GraphQLError): GraphQLFormattedError {
  const { code } = error.extensions;
  return {
    ...error.toJSON(),
    extensions: {
      ...error.extensions,
      code: typeof code === 'string' ? code : 'GRAPHQL_VALIDATION_FAILED',
    },
  };
}

/**
 * What a running subscription threw. graphql-ws wraps it in a pathless GraphQLError
 * (`originalError`, or `cause` with graphql 17) that copies its `extensions`, and
 * `unwrapResolverError` keeps that wrapper.
 * `undefined`: a client validation error.
 */
export function serverProtocolOriginal(error: GraphQLError): unknown {
  return error.originalError ?? (error as { cause?: unknown }).cause ?? undefined;
}

/** graphql-ws `onError` bypasses Apollo's formatError, so server failures must be masked here. */
export function formatProtocolErrors(
  errors: readonly GraphQLError[],
): { error: GraphQLFormattedError; fromClient: boolean }[] {
  return errors.map((error) => {
    const thrown = serverProtocolOriginal(error);
    return thrown !== undefined
      ? { error: formatOriginal(error.toJSON(), thrown), fromClient: false }
      : {
          error: {
            ...error.toJSON(),
            extensions: { ...error.extensions, code: 'GRAPHQL_VALIDATION_FAILED' },
          },
          fromClient: true,
        };
  });
}
