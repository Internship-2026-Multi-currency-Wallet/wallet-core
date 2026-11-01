import { join } from 'node:path';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { AppConfig } from '../config/app-config.js';
import { type RequestLike, requestFromConnectionParams } from '../auth/request-context.js';

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
export function graphqlOptions(config: AppConfig): ApolloDriverConfig {
  return {
    driver: ApolloDriver,
    autoSchemaFile: config.isProduction ? true : SCHEMA_FILE,
    sortSchema: true,
    path: '/graphql',
    introspection: true,
    // GraphQL subscriptions over websocket (graphql-ws protocol) on the same path.
    subscriptions: { 'graphql-ws': { path: '/graphql' } },
    // HTTP requests carry headers; websocket requests carry connectionParams.
    // Both end up as `context.req.headers`, which the auth guard reads.
    context: ({ req, connectionParams }: ContextInput) => ({
      req: req ?? requestFromConnectionParams(connectionParams),
    }),
  };
}
