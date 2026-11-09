import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';
import type { Response } from 'express';
import type { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { Metrics } from '../metrics/metrics.js';
import { type GraphqlContext, graphqlOptions } from './graphql.config.js';

const logger = { setContext: jest.fn() } as unknown as PinoLogger;
const context = graphqlOptions(AppConfig.fromEnv({}), logger).context as (
  input: Record<string, unknown>,
) => GraphqlContext;

describe('graphqlOptions context', () => {
  it('passes the HTTP request and response to resolvers', () => {
    const req = { headers: { authorization: 'Dev 1:wallet' } };
    const res = {} as Response;
    expect(context({ req, res })).toEqual({ req, res });
  });

  it('builds the request from websocket connection params, without a response', () => {
    expect(context({ connectionParams: { Authorization: 'Dev 1:wallet' } })).toEqual({
      req: { headers: { authorization: 'Dev 1:wallet' } },
      res: undefined,
    });
  });
});

describe('graphqlOptions websocket connections gauge', () => {
  const wsLogger = { setContext: jest.fn(), debug: jest.fn() } as unknown as PinoLogger;
  const open = async (metrics: Metrics) =>
    (await metrics.graphqlWsConnections.get()).values[0]?.value ?? 0;

  function hooks(metrics: Metrics) {
    const ws = graphqlOptions(AppConfig.fromEnv({}), wsLogger, metrics).subscriptions?.[
      'graphql-ws'
    ] as {
      onConnect: (ctx: object) => void;
      onClose: (ctx: object) => void;
    };
    return ws;
  }

  it('decrements on close also for a socket that closed before the acknowledgement', async () => {
    const metrics = new Metrics({ service: 'wallet-core', env: 'local' });
    const ws = hooks(metrics);
    const socket = { extra: {} };
    ws.onConnect(socket);
    expect(await open(metrics)).toBe(1);
    ws.onClose(socket);
    expect(await open(metrics)).toBe(0);
  });

  it('never goes below zero for a socket that closed before onConnect', async () => {
    const metrics = new Metrics({ service: 'wallet-core', env: 'local' });
    const ws = hooks(metrics);
    ws.onClose({ extra: {} });
    expect(await open(metrics)).toBe(0);
  });
});

describe('graphqlOptions websocket protocol errors', () => {
  const wsLogger = { setContext: jest.fn(), debug: jest.fn() } as unknown as PinoLogger;
  type OnError = (
    ctx: object,
    id: string,
    payload: { query: string },
    errors: GraphQLError[],
  ) => { message: string; extensions?: { code?: string } }[];

  function setup() {
    const metrics = new Metrics({ service: 'wallet-core', env: 'local' });
    const ws = graphqlOptions(AppConfig.fromEnv({}), wsLogger, metrics).subscriptions?.[
      'graphql-ws'
    ] as unknown as { onError: OnError };
    return { metrics, onError: ws.onError };
  }

  it('counts a validation error as a client error and keeps its message', async () => {
    const { metrics, onError } = setup();
    const result = onError({}, '1', { query: 'query Q { nope }' }, [
      new GraphQLError('Cannot query field "nope"'),
    ]);
    expect(result).toMatchObject([
      { message: 'Cannot query field "nope"', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } },
    ]);
    expect(await metrics.registry.metrics()).toContain(
      'graphql_errors_total{operation="(unknown)",code="GRAPHQL_VALIDATION_FAILED"',
    );
  });

  it('masks a failure of a running subscription and counts it as a server error', async () => {
    const { metrics, onError } = setup();
    const leak = new Error("Duplicate entry 'artem@test.com'");
    const result = onError({}, '1', { query: 'subscription S { ticks }' }, [
      new GraphQLError(leak.message, { originalError: leak }),
    ]);
    expect(result).toMatchObject([
      { message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
    ]);
    expect(JSON.stringify(result)).not.toContain('artem@test.com');
    expect(await metrics.registry.metrics()).toContain(
      'graphql_errors_total{operation="subscription ticks",code="INTERNAL_SERVER_ERROR"',
    );
  });

  it('masks a subscription failure wrapped the graphql 17 way (cause, no originalError)', () => {
    const { onError } = setup();
    const leak = new Error("Duplicate entry 'artem@test.com'");
    const wrapped = Object.assign(new GraphQLError(leak.message), { cause: leak });
    const result = onError({}, '1', { query: 'subscription S { ticks }' }, [wrapped]);
    expect(result).toMatchObject([{ extensions: { code: 'INTERNAL_SERVER_ERROR' } }]);
    expect(JSON.stringify(result)).not.toContain('artem@test.com');
  });
});
