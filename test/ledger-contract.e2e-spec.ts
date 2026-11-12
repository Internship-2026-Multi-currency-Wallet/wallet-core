import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { createClient } from 'graphql-ws';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import WebSocket from 'ws';
import { TokenService } from '../src/auth/tokens.js';
import { createApp } from './create-app.js';

/**
 * Ledger GraphQL contract: who may call which operation, and where `testCredit` exists.
 * The operations are stubs, so a call that passes the guards answers "not implemented".
 */
describe('ledger contract (e2e)', () => {
  const USER_ID = '00000000-0000-4000-8000-000000000001';
  const DEV_USER = 'Dev 1:wallet';
  const TEST_CREDIT = 'mutation { testCredit(currency: UAH, amount: "10050") { currency amount } }';

  interface GqlBody {
    data?: Record<string, unknown> | null;
    errors?: { message: string; extensions: { code: string } }[];
  }

  interface FieldInfo {
    name: string;
    args: { name: string }[];
  }

  const gql = async (
    app: INestApplication,
    query: string,
    authorization?: string,
  ): Promise<GqlBody> => {
    const req = request(app.getHttpServer() as App).post('/graphql');
    if (authorization) req.set('Authorization', authorization);
    return (await req.send({ query })).body as GqlBody;
  };

  const jwt = (app: INestApplication): string => {
    const subject = { userId: USER_ID, aud: 'wallet' as const, permissions: ['wallet'] };
    return `Bearer ${app.get(TokenService).signAccessToken(subject, new Date()).token}`;
  };

  describe('on APP_ENV=local with dev auth', () => {
    let app: INestApplication;
    let wsUrl: string;

    beforeAll(async () => {
      app = await createApp({ APP_ENV: 'local', DEV_AUTH: 'true' });
      await app.listen(0, '127.0.0.1');
      const { port } = (app.getHttpServer() as { address(): AddressInfo }).address();
      wsUrl = `ws://127.0.0.1:${port}/graphql`;
    });

    afterAll(async () => {
      await app.close();
    });

    /** Message of the first error of a subscription; fails if it delivers data. A resolver error arrives as a result with `errors`. */
    const subscribeError = async (query: string, authorization?: string): Promise<string> => {
      const client = createClient({
        url: wsUrl,
        webSocketImpl: WebSocket,
        retryAttempts: 0,
        connectionParams: authorization ? { Authorization: authorization } : {},
      });
      try {
        return await new Promise<string>((resolve, reject) => {
          client.subscribe(
            { query },
            {
              next: (result) => {
                if (result.errors?.length) resolve(result.errors[0].message);
                else reject(new Error(`unexpected result: ${JSON.stringify(result)}`));
              },
              error: reject,
              complete: () => reject(new Error('completed without an error')),
            },
          );
        });
      } finally {
        await client.dispose();
      }
    };

    it('balances requires authentication', async () => {
      const body = await gql(app, '{ balances { currency amount decimals } }');
      expect(body.errors?.[0]).toMatchObject({
        message: 'Authentication required',
        extensions: { code: 'UNAUTHENTICATED' },
      });
    });

    it('balances reaches the stub for a logged-in user', async () => {
      const body = await gql(app, '{ balances { currency amount decimals } }', DEV_USER);
      expect(body.errors?.[0].message).toBe('balances is not implemented yet');
    });

    it('testCredit requires authentication', async () => {
      const body = await gql(app, TEST_CREDIT);
      expect(body.errors?.[0]).toMatchObject({
        message: 'Authentication required',
        extensions: { code: 'UNAUTHENTICATED' },
      });
    });

    it('testCredit rejects an unknown currency before reaching the stub', async () => {
      const body = await gql(
        app,
        'mutation { testCredit(currency: BTC, amount: "1") { amount } }',
        DEV_USER,
      );
      expect(body.errors).toHaveLength(1);
      expect(body.errors?.[0].message).not.toMatch(/not implemented/);
    });

    it('balanceChanged requires authentication', async () => {
      await expect(subscribeError('subscription { balanceChanged { currency } }')).resolves.toBe(
        'Authentication required',
      );
    });

    it('balanceChanged reaches the stub for a logged-in user', async () => {
      await expect(
        subscribeError('subscription { balanceChanged { currency } }', DEV_USER),
      ).resolves.toBe('balanceChanged is not implemented yet');
    });

    it('takes the owner from the token: no userId argument anywhere', async () => {
      const body = await gql(
        app,
        `{
          subscription: __type(name: "Subscription") { fields { name args { name } } }
          mutation: __type(name: "Mutation") { fields { name args { name } } }
        }`,
        DEV_USER,
      );
      const { subscription, mutation } = body.data as Record<
        'subscription' | 'mutation',
        { fields: FieldInfo[] }
      >;
      const argsOf = (fields: FieldInfo[], name: string): string[] | undefined =>
        fields
          .find((field) => field.name === name)
          ?.args.map((arg) => arg.name)
          .sort();

      expect(argsOf(subscription.fields, 'balanceChanged')).toEqual([]);
      expect(argsOf(mutation.fields, 'testCredit')).toEqual(['amount', 'currency']);
    });
  });

  describe('testCredit by APP_ENV', () => {
    let app: INestApplication | undefined;

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    it.each(['local', 'staging'])('exists on %s', async (appEnv) => {
      app = await createApp({ APP_ENV: appEnv, DEV_AUTH: 'true' });
      const body = await gql(app, TEST_CREDIT, DEV_USER);
      expect(body.errors?.[0].message).toBe('testCredit is not implemented yet');
    });

    // Dev auth is refused on client environments, so a real token is the only way in.
    it.each(['kvitka-uat', 'wisla-uat'])('answers NOT_FOUND on %s', async (appEnv) => {
      app = await createApp({ APP_ENV: appEnv, DEV_AUTH: 'false' });
      const body = await gql(app, TEST_CREDIT, jwt(app));
      expect(body.errors?.[0]).toMatchObject({
        message: 'Not Found',
        extensions: { code: 'NOT_FOUND' },
      });
    });
  });
});
