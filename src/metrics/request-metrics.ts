import type { ApolloServerPlugin } from '@apollo/server';
import type { NextFunction, Request, Response } from 'express';
import type { GraphQLFormattedError } from 'graphql';
import type { GraphqlOperationInfo } from '../logging/logger.options.js';
import type { Metrics } from './metrics.js';

const NOT_COUNTED = new Set(['/health', '/metrics']);
const CLIENT_CLOSED = 499;

interface CountedRequest {
  method?: string;
  graphqlOperation?: GraphqlOperationInfo;
  route?: { path?: unknown };
}

export function operationName(req: CountedRequest | undefined): string | undefined {
  const op = req?.graphqlOperation;
  if (op) return op.name ? `${op.type} ${op.name}` : undefined;
  const path = req?.route?.path;
  return typeof path === 'string' ? `${req?.method} ${path}` : undefined;
}

export function requestMetricsMiddleware(metrics: Metrics) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const path = req.originalUrl.split('?')[0];
    if (req.method === 'OPTIONS' || NOT_COUNTED.has(path)) {
      next();
      return;
    }
    const observeDuration = metrics.httpRequestDuration.startTimer();
    res.once('close', () => {
      const operation = metrics.operation(operationName(req as CountedRequest));
      observeDuration({ operation });
      const status = res.writableFinished ? res.statusCode : CLIENT_CLOSED;
      metrics.httpRequests.inc({ operation, status });
    });
    next();
  };
}

export function graphqlErrorCode(error: GraphQLFormattedError): string {
  const code = error.extensions?.code;
  return typeof code === 'string' ? code : 'INTERNAL_SERVER_ERROR';
}

export function graphqlMetricsPlugin(
  metrics: Metrics,
): ApolloServerPlugin<{ req?: CountedRequest }> {
  return {
    requestDidStart() {
      return Promise.resolve({
        willSendResponse({ contextValue, response }) {
          const { body } = response;
          const errors =
            body.kind === 'single' ? body.singleResult.errors : body.initialResult.errors;
          if (errors?.length) {
            const operation = metrics.operation(operationName(contextValue.req));
            for (const code of new Set(errors.map(graphqlErrorCode))) {
              metrics.graphqlErrors.inc({ operation, code });
            }
          }
          return Promise.resolve();
        },
      });
    },
  };
}
