import { join } from 'node:path';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import type { Response } from 'express';
import { type DocumentNode, type GraphQLError, type GraphQLFormattedError, parse } from 'graphql';
import type { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { AuthErrorCode } from '../auth/auth-errors.js';
import { type RequestLike, requestFromConnectionParams } from '../auth/request-context.js';
import { graphqlLoggingPlugin, subscriptionLoggingHooks } from '../logging/graphql-logging.js';
import type { Metrics } from '../metrics/metrics.js';
import {
  countGraphqlErrors,
  graphqlMetricsPlugin,
  wsOperationName,
} from '../metrics/request-metrics.js';
import { formatError, formatExecutionResult, formatProtocolErrors } from './format-error.js';

/** Path of the committed GraphQL contract. Other repositories consume this file. */
export const SCHEMA_FILE = join(process.cwd(), 'schema.graphql');

interface ContextInput {
  req?: RequestLike;
  res?: Response;
  connectionParams?: Record<string, unknown>;
  extra?: { request?: unknown };
}

const CLIENT_ERROR_CODES = Object.values(AuthErrorCode);

export interface GraphqlContext {
  req: RequestLike;
  /** Absent over websocket. */
  res?: Response;
}

function parseQuery(query: string | undefined): DocumentNode | undefined {
  try {
    return query ? parse(query) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Apollo, code-first. Outside production the schema is written to `schema.graphql`
 * (sorted, so diffs are stable) — commit it together with resolver changes.
 */
export function graphqlOptions(
  config: AppConfig,
  logger: PinoLogger,
  metrics?: Metrics,
): ApolloDriverConfig {
  logger.setContext('GraphQL');
  const wsLogging = subscriptionLoggingHooks(logger);
  const countedSockets = new WeakSet<object>();
  const onProtocolError = (
    _ctx: unknown,
    _id: string,
    payload: { query?: string; operationName?: string | null },
    errors: readonly GraphQLError[],
  ): GraphQLFormattedError[] => {
    const formatted = formatProtocolErrors(errors);
    if (metrics) {
      const fromClient = formatted.filter((item) => item.fromClient).map((item) => item.error);
      const fromServer = formatted.filter((item) => !item.fromClient).map((item) => item.error);
      countGraphqlErrors(metrics, undefined, fromClient);
      countGraphqlErrors(
        metrics,
        wsOperationName(parseQuery(payload.query), payload.operationName),
        fromServer,
      );
    }
    return formatted.map((item) => item.error);
  };
  return {
    driver: ApolloDriver,
    autoSchemaFile: config.isProduction ? true : SCHEMA_FILE,
    sortSchema: true,
    path: '/graphql',
    introspection: true,
    // GraphQL subscriptions over websocket (graphql-ws protocol) on the same path.
    // Subscription start/end are logged with the connection's requestId.
    subscriptions: {
      'graphql-ws': {
        path: '/graphql',
        ...wsLogging,
        onConnect: (ctx) => {
          wsLogging.onConnect(ctx);
          if (metrics && !countedSockets.has(ctx)) {
            countedSockets.add(ctx);
            metrics.graphqlWsConnections.inc();
          }
        },
        onClose: (ctx) => {
          if (countedSockets.delete(ctx)) metrics?.graphqlWsConnections.dec();
        },
        // Apollo's formatError does not see websocket results: mask them the same way.
        onNext: (_ctx, _id, _payload, args, result) => {
          const formatted = formatExecutionResult(result);
          if (metrics) {
            countGraphqlErrors(
              metrics,
              wsOperationName(args.document, args.operationName),
              (formatted ?? result).errors,
            );
          }
          return formatted;
        },
        // Nest's config type omits onError but passes every option on to graphql-ws, so this works;
        // the spread keeps the type check from rejecting it.
        ...{ onError: onProtocolError },
      },
    },
    // Names the operation in the access log and logs resolver errors with the requestId.
    plugins: [
      graphqlLoggingPlugin({ clientErrorCodes: CLIENT_ERROR_CODES }),
      ...(metrics ? [graphqlMetricsPlugin(metrics)] : []),
    ],
    // Unexpected errors reach the client as a bare INTERNAL_SERVER_ERROR (no SQL, no internals).
    formatError,
    // HTTP requests carry headers; websocket requests carry connectionParams.
    // Both end up as `context.req.headers`, which the auth guard reads.
    context: ({ req, res, connectionParams }: ContextInput): GraphqlContext => ({
      req: req ?? requestFromConnectionParams(connectionParams),
      res,
    }),
  };
}
