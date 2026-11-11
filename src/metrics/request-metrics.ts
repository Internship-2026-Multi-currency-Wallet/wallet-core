import type { ApolloServerPlugin } from '@apollo/server';
import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import {
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLFormattedError,
  Kind,
  type OperationDefinitionNode,
  type SelectionNode,
} from 'graphql';
import { Metrics, requestExemplar } from './metrics.js';

const NOT_COUNTED = new Set(['/health', '/metrics']);

function normalizedPath(url: string): string {
  return (url.split('?')[0] ?? '').toLowerCase().replace(/\/+$/, '') || '/';
}
const CLIENT_CLOSED = 499;

interface CountedRequest {
  /** requestId, set by pino-http. */
  id?: unknown;
  method?: string;
  metricsOperation?: string;
  route?: { path?: unknown };
}

/**
 * Labelled by the first root field, not by the client's operation name: field names are bounded by
 * the schema, while any client can invent operation names and fill the label cap with them.
 */
function graphqlOperationLabel(
  operation: OperationDefinitionNode,
  document: DocumentNode | undefined,
): string | undefined {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document?.definitions ?? []) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }
  const field = firstField(operation.selectionSet.selections, fragments, new Set());
  return field ? `${operation.operation} ${field}` : undefined;
}

function firstField(
  selections: readonly SelectionNode[],
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  visited: Set<string>,
): string | undefined {
  for (const node of selections) {
    if (node.kind === Kind.FIELD) return node.name.value;
    let nested: readonly SelectionNode[] | undefined;
    if (node.kind === Kind.INLINE_FRAGMENT) nested = node.selectionSet.selections;
    else if (!visited.has(node.name.value)) {
      // Guards against fragment cycles, which reach this point before validation rejects them.
      visited.add(node.name.value);
      nested = fragments.get(node.name.value)?.selectionSet.selections;
    }
    const field = nested && firstField(nested, fragments, visited);
    if (field) return field;
  }
  return undefined;
}

export function operationName(req: CountedRequest | undefined): string | undefined {
  if (req?.metricsOperation) return req.metricsOperation;
  const path = req?.route?.path;
  if (typeof path !== 'string' || path.includes('*') || path.startsWith('/graphql')) {
    return undefined;
  }
  return `${req?.method} ${path}`;
}

export function requestMetricsMiddleware(metrics: Metrics) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'OPTIONS' || NOT_COUNTED.has(normalizedPath(req.originalUrl))) {
      next();
      return;
    }
    const start = performance.now();
    res.once('close', () => {
      const counted = req as CountedRequest;
      const operation = metrics.operation(operationName(counted));
      metrics.httpRequestDuration.observe({
        labels: { operation },
        value: (performance.now() - start) / 1000,
        exemplarLabels: requestExemplar(counted.id),
      });
      const status = res.writableFinished ? res.statusCode : CLIENT_CLOSED;
      metrics.httpRequests.inc({ operation, status });
    });
    next();
  };
}

export function useRequestMetrics(app: INestApplication): void {
  app.use(requestMetricsMiddleware(app.get(Metrics)));
}

export function graphqlErrorCode(error: GraphQLFormattedError): string {
  const code = error.extensions?.code;
  return typeof code === 'string' ? code : 'INTERNAL_SERVER_ERROR';
}

export function wsOperationName(
  document: DocumentNode | undefined,
  operationName?: string | null,
): string | undefined {
  const operations = (document?.definitions ?? []).filter(
    (definition) => definition.kind === Kind.OPERATION_DEFINITION,
  );
  const operation = operationName
    ? operations.find((candidate) => candidate.name?.value === operationName)
    : operations.length === 1
      ? operations[0]
      : undefined;
  return operation && graphqlOperationLabel(operation, document);
}

export function countGraphqlErrors(
  metrics: Metrics,
  operationName: string | undefined,
  errors: readonly GraphQLFormattedError[] | undefined,
  requestId?: unknown,
): void {
  if (!errors?.length) return;
  const operation = metrics.operation(operationName);
  for (const code of new Set(errors.map(graphqlErrorCode))) {
    metrics.graphqlErrors.inc({
      labels: { operation, code },
      exemplarLabels: requestExemplar(requestId),
    });
  }
}

export function graphqlMetricsPlugin(
  metrics: Metrics,
): ApolloServerPlugin<{ req?: CountedRequest }> {
  return {
    requestDidStart() {
      return Promise.resolve({
        didResolveOperation({ contextValue, operation, document }) {
          if (contextValue.req && operation) {
            contextValue.req.metricsOperation = graphqlOperationLabel(operation, document);
          }
          return Promise.resolve();
        },
        willSendResponse({ contextValue, response }) {
          const { body } = response;
          const errors =
            body.kind === 'single' ? body.singleResult.errors : body.initialResult.errors;
          countGraphqlErrors(
            metrics,
            operationName(contextValue.req),
            errors,
            contextValue.req?.id,
          );
          return Promise.resolve();
        },
      });
    },
  };
}
