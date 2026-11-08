import { jest } from '@jest/globals';
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
