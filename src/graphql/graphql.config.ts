import { join } from 'node:path';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import type { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { type RequestLike, requestFromConnectionParams } from '../auth/request-context.js';
import { graphqlLoggingPlugin, subscriptionLoggingHooks } from '../logging/graphql-logging.js';

/** Path of the committed GraphQL contract. Other repositories consume this file. */
export const SCHEMA_FILE = join(process.cwd(), 'schema.graphql');

interface ContextInput {
  req?: RequestLike;
  connectionParams?: Record<string, unknown>;
  extra?: { request?: unknown };
}

/**
 * Apollo, code-first. Outside production the schema is written to `schema.graphql`
 * (sorted, so diffs are stable) — commit it together with resolver changes.
 */
export function graphqlOptions(config: AppConfig, logger: PinoLogger): ApolloDriverConfig {
  logger.setContext('GraphQL');
  return {
    driver: ApolloDriver,
    autoSchemaFile: config.isProduction ? true : SCHEMA_FILE,
    sortSchema: true,
    path: '/graphql',
    introspection: true,
    // GraphQL subscriptions over websocket (graphql-ws protocol) on the same path.
    // Subscription start/end are logged with the connection's requestId.
    subscriptions: { 'graphql-ws': { path: '/graphql', ...subscriptionLoggingHooks(logger) } },
    // Names the operation in the access log and logs resolver errors with the requestId.
    plugins: [graphqlLoggingPlugin()],
    // HTTP requests carry headers; websocket requests carry connectionParams.
    // Both end up as `context.req.headers`, which the auth guard reads.
    context: ({ req, connectionParams }: ContextInput) => ({
      req: req ?? requestFromConnectionParams(connectionParams),
    }),
  };
}
