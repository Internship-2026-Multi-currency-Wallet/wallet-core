import { jest } from '@jest/globals';
import type { Response } from 'express';
import type { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
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
