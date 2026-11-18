/**
 * Keep this file and `graphql/expected-error.filter.ts` IDENTICAL in wallet-core, rates-service
 * and treasury-service.
 */
import type { ApolloServerPlugin } from '@apollo/server';
import { unwrapResolverError } from '@apollo/server/errors';
import { HttpException } from '@nestjs/common';
import type { ExecutionArgs, GraphQLError } from 'graphql';
import type { PinoLogger } from 'nestjs-pino';
import type { Logger } from 'pino';
import { isExpectedGraphqlError } from '../graphql/expected-error.filter.js';
import { type GraphqlOperationInfo, REDACTED, requestIdFrom } from './logger.options.js';

interface GraphqlContext {
  req?: { graphqlOperation?: GraphqlOperationInfo; log?: Logger };
}

/**
 * GraphQL's coercion errors quote the value, which can be a whole row: a resolver returning a user
 * for a String field gives `String cannot represent value: { passwordHash: "…" }`.
 */
const COERCED_VALUE = /(cannot represent [^:]*value): .*$/s;

/**
 * Everything after it is hidden: the client's variable (password included) is quoted there, and
 * the reason after it can quote it again, so no part of that text can be trusted to be safe.
 */
const VARIABLE_VALUE = /(got invalid value ).*$/s;

function withoutValue(text: string): string {
  return text.replace(VARIABLE_VALUE, `$1${REDACTED}`).replace(COERCED_VALUE, `$1: ${REDACTED}`);
}

/**
 * A copy, because the same error then goes to formatError and a client error's message reaches
 * the client.
 */
function loggableError(error: Error): Error {
  const message = withoutValue(error.message);
  if (message === error.message) return error;
  const copy = Object.assign(Object.create(Object.getPrototypeOf(error) as object) as Error, error);
  copy.message = message;
  copy.stack = error.stack?.replace(error.message, () => message);
  return copy;
}

/**
 * Nest HTTP exceptions (e.g. UnauthorizedException) carry a status before Apollo maps them. A
 * `status` on any other error (e.g. from a downstream HTTP client) does not make it one.
 */
function httpStatusOf(thrown: unknown): number | undefined {
  return thrown instanceof HttpException ? thrown.getStatus() : undefined;
}

function isClientStatus(status: number | undefined): status is number {
  return status !== undefined && status >= 400 && status < 500;
}

/**
 * Expected errors (see `isExpectedGraphqlError`) and Nest 4xx exceptions are logged at warn
 * without `err`; anything else at error with the stack.
 */
export function graphqlLoggingPlugin(): ApolloServerPlugin<GraphqlContext> {
  return {
    requestDidStart() {
      return Promise.resolve({
        didResolveOperation({ contextValue, operation, operationName }) {
          if (contextValue.req && operation) {
            contextValue.req.graphqlOperation = {
              type: operation.operation,
              name: operationName ?? null,
            };
          }
          return Promise.resolve();
        },
        didEncounterErrors({ contextValue, errors, operationName }) {
          const log = contextValue.req?.log;
          if (!log) return Promise.resolve();
          for (const error of errors) {
            const status = httpStatusOf(error.originalError);
            const rawCode = error.extensions?.code;
            const code =
              typeof rawCode === 'string'
                ? rawCode
                : status !== undefined
                  ? `HTTP_${status}`
                  : 'INTERNAL_SERVER_ERROR';
            const clientError =
              isExpectedGraphqlError(unwrapResolverError(error)) || isClientStatus(status);
            const fields = {
              context: 'GraphQL',
              operation: operationName ?? null,
              code,
              path: error.path?.join('.'),
              ...(clientError ? {} : { err: loggableError(error.originalError ?? error) }),
            };
            const msg = `GraphQL error: ${withoutValue(error.message)}`;
            if (clientError) log.warn(fields, msg);
            else log.error(fields, msg);
          }
          return Promise.resolve();
        },
      });
    },
  };
}

interface WsExtra {
  request?: { headers?: Record<string, unknown> };
  requestId?: string;
}

export interface WsContext {
  connectionParams?: Readonly<Record<string, unknown>>;
  extra: unknown;
}

export interface WsSubscribePayload {
  operationName?: string | null;
  query?: string;
}

function lowerCaseKeys(params: Readonly<Record<string, unknown>> | undefined) {
  return Object.fromEntries(Object.entries(params ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
}

/** The connection's request id (assigned on connect). */
export function wsRequestId(ctx: WsContext): string {
  const extra = ctx.extra as WsExtra;
  extra.requestId ??= requestIdFrom({
    ...extra.request?.headers,
    ...lowerCaseKeys(ctx.connectionParams),
  });
  return extra.requestId;
}

/**
 * graphql-ws results bypass Apollo's logging plugin. One record per error, named like the
 * operation's started/completed lines. Never throws: graphql-ws would pass the failure to
 * `onError`, which logs and counts the error again and ends the subscription.
 */
export function logWsErrors(
  logger: PinoLogger,
  ctx: WsContext,
  operation: { id: string; payload: WsSubscribePayload },
  errors: readonly GraphQLError[] | undefined,
  serverOriginal: (error: GraphQLError) => unknown,
): void {
  for (const error of errors ?? []) {
    try {
      logWsError(logger, ctx, operation, error, serverOriginal);
    } catch {
      // Dropped: what failed is most likely the logger, so it cannot be logged either.
    }
  }
}

function logWsError(
  logger: PinoLogger,
  ctx: WsContext,
  { id, payload }: { id: string; payload: WsSubscribePayload },
  error: GraphQLError,
  serverOriginal: (error: GraphQLError) => unknown,
): void {
  const thrown = serverOriginal(error);
  const original = thrown ?? error;
  const expected = isExpectedGraphqlError(original);
  if (!expected && thrown === undefined) return;
  const status = httpStatusOf(thrown);
  const refusal = isClientStatus(status) ? `HTTP_${status}` : undefined;
  const fields = {
    requestId: wsRequestId(ctx),
    subscriptionId: id,
    operation: operationOf(payload),
    // An unexpected error is masked for the client, whatever its wrapper carries.
    code: expected ? original.extensions.code : (refusal ?? 'INTERNAL_SERVER_ERROR'),
    path: error.path?.join('.'),
  };
  const msg = `GraphQL error: ${withoutValue(error.message)}`;
  if (expected || refusal) logger.warn(fields, msg);
  else
    logger.error(
      { ...fields, err: loggableError(original instanceof Error ? original : error) },
      msg,
    );
}

/**
 * graphql-ws consumes subscription iterators outside execution, so both execution and iterator
 * methods need the connection's logging context.
 */
export function inWsLoggingContext<T>(
  logger: PinoLogger,
  run: (args: ExecutionArgs) => T,
): (args: ExecutionArgs) => T {
  return (args) => {
    const { requestId } = (args.contextValue ?? {}) as { requestId?: string };
    const inContext = <R>(fn: () => R): R => logger.runInContext(fn, { bindings: { requestId } });
    const result = inContext(() => run(args));
    const bind = (value: unknown): unknown =>
      isAsyncIterable(value) ? boundIterator(value[Symbol.asyncIterator](), inContext) : value;
    return (result instanceof Promise ? result.then(bind) : bind(result)) as T;
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof (value as AsyncIterable<unknown> | null)?.[Symbol.asyncIterator] === 'function';
}

/** `return` and `throw` only if the iterator has them: graphql-ws calls `return` only then. */
function boundIterator<T>(
  iterator: AsyncIterator<T>,
  inContext: <R>(fn: () => R) => R,
): AsyncIterableIterator<T> {
  const stop = iterator.return?.bind(iterator);
  const fail = iterator.throw?.bind(iterator);
  return {
    next: (...value: [] | [unknown]) => inContext(() => iterator.next(...value)),
    ...(stop && { return: (value?: unknown) => inContext(() => stop(value)) }),
    ...(fail && { throw: (error?: unknown) => inContext(() => fail(error)) }),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/**
 * Read from the text: the lifecycle lines are written before graphql-ws parses the document.
 * graphql-ws clients (ours included) often send no `operationName`, so the document's own name
 * comes next, then the first field.
 */
function operationOf(payload: WsSubscribePayload): string {
  const query = payload.query ?? '';
  const head = /^\s*(query|mutation|subscription)\b\s*(\w*)/.exec(query);
  const type = head?.[1] ?? (/^\s*\{/.test(query) ? 'query' : 'subscription');
  const field = /\{\s*(\w+)/.exec(query)?.[1];
  return `${type} ${payload.operationName || head?.[2] || field || '(anonymous)'}`;
}

/** graphql-ws server hooks that log the subscription lifecycle. Spread into `'graphql-ws'` options. */
export function subscriptionLoggingHooks(logger: PinoLogger) {
  return {
    onConnect: (ctx: WsContext) => {
      logger.debug({ requestId: wsRequestId(ctx) }, 'websocket connected');
    },
    onSubscribe: (ctx: WsContext, id: string, payload: WsSubscribePayload) => {
      logger.info(
        { requestId: wsRequestId(ctx), subscriptionId: id, operation: operationOf(payload) },
        `${operationOf(payload)} started`,
      );
    },
    onComplete: (ctx: WsContext, id: string, payload: WsSubscribePayload) => {
      logger.info(
        { requestId: wsRequestId(ctx), subscriptionId: id, operation: operationOf(payload) },
        `${operationOf(payload)} completed`,
      );
    },
    onDisconnect: (ctx: WsContext, code?: number) => {
      logger.debug({ requestId: wsRequestId(ctx), code }, 'websocket disconnected');
    },
  };
}
