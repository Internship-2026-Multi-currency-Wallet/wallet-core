/**
 * GraphQL logging. This file is IDENTICAL in wallet-core, rates-service and treasury-service.
 *
 * - HTTP operations: the Apollo plugin stores the operation (`query Me`) on the request, so the
 *   access log line names it, and logs resolver errors with the request's `requestId`.
 * - Subscriptions (graphql-ws): one `requestId` per websocket connection, taken from
 *   `x-request-id` in the connection params or the upgrade request, else generated. Subscription
 *   start/end are logged with it.
 */
import type { ApolloServerPlugin } from '@apollo/server';
import type { PinoLogger } from 'nestjs-pino';
import type { Logger } from 'pino';
import { type GraphqlOperationInfo, requestIdFrom } from './logger.options.js';

interface GraphqlContext {
  req?: { graphqlOperation?: GraphqlOperationInfo; log?: Logger };
}

/** Error codes caused by the client (logged as `warn`); anything else is a server `error`. */
const CLIENT_ERROR_CODES = new Set([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'BAD_USER_INPUT',
  'BAD_REQUEST',
  'GRAPHQL_PARSE_FAILED',
  'GRAPHQL_VALIDATION_FAILED',
  'PERSISTED_QUERY_NOT_FOUND',
  'OPERATION_RESOLUTION_FAILURE',
]);

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
            // Nest HTTP exceptions (e.g. UnauthorizedException) carry a status before Apollo maps them.
            const status = (error.originalError as { status?: unknown } | undefined)?.status;
            const rawCode = error.extensions?.code;
            const code =
              typeof rawCode === 'string'
                ? rawCode
                : typeof status === 'number'
                  ? `HTTP_${status}`
                  : 'INTERNAL_SERVER_ERROR';
            const clientError =
              CLIENT_ERROR_CODES.has(code) ||
              (typeof status === 'number' && status >= 400 && status < 500);
            const fields = {
              context: 'GraphQL',
              operation: operationName ?? null,
              code,
              path: error.path?.join('.'),
              ...(clientError ? {} : { err: error.originalError ?? error }),
            };
            if (clientError) log.warn(fields, `GraphQL error: ${error.message}`);
            else log.error(fields, `GraphQL error: ${error.message}`);
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

interface WsContext {
  connectionParams?: Readonly<Record<string, unknown>>;
  extra: unknown;
}

interface WsSubscribePayload {
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

function operationOf(payload: WsSubscribePayload): string {
  const field = /\{\s*(\w+)/.exec(payload.query ?? '')?.[1];
  return `subscription ${payload.operationName ?? field ?? '(anonymous)'}`;
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
