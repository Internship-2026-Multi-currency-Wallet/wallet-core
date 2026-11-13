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
  // A staff token carries no `wallet` permission; `bo` is how dev auth makes a staff caller.
  const STAFF = 'Dev 1:bo';
  const TEST_CREDIT = 'mutation { testCredit(currency: UAH, amount: "10050") { currency amount } }';

  interface GqlError {
    message: string;
    extensions: { code: string };
  }

  interface GqlBody {
    data?: Record<string, unknown> | null;
    errors?: GqlError[];
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
    let app: INestApplication | undefined;
    let wsUrl: string;

    // If `createApp` fails, the tests fail here with a clear message instead of a TypeError on `undefined`.
    const server = (): INestApplication => {
      if (!app) throw new Error('the application was not created');
      return app;
    };

    beforeAll(async () => {
      app = await createApp({ APP_ENV: 'local', DEV_AUTH: 'true' });
      await app.listen(0, '127.0.0.1');
      const { port } = (app.getHttpServer() as { address(): AddressInfo }).address();
      wsUrl = `ws://127.0.0.1:${port}/graphql`;
    });

    afterAll(async () => {
      await app?.close();
    });

    /** First error of a subscription; fails if it delivers data. A resolver error arrives as a result with `errors`. */
    const subscribeError = async (query: string, authorization?: string): Promise<GqlError> => {
      const client = createClient({
        url: wsUrl,
        webSocketImpl: WebSocket,
        retryAttempts: 0,
        connectionParams: authorization ? { Authorization: authorization } : {},
      });
      try {
        return await new Promise<GqlError>((resolve, reject) => {
          client.subscribe(
            { query },
            {
              next: (result) => {
                if (result.errors?.length) resolve(result.errors[0] as GqlError);
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
      const body = await gql(server(), '{ balances { currency amount decimals } }');
      expect(body.errors?.[0]).toMatchObject({
        message: 'Authentication required',
        extensions: { code: 'UNAUTHENTICATED' },
      });
    });

    it('balances reaches the stub for a logged-in user', async () => {
      const body = await gql(server(), '{ balances { currency amount decimals } }', DEV_USER);
      expect(body.errors?.[0].message).toBe('balances is not implemented yet');
    });

    it('balances is forbidden for staff', async () => {
      const body = await gql(server(), '{ balances { currency } }', STAFF);
      expect(body.errors?.[0].extensions.code).toBe('FORBIDDEN');
    });

    it('testCredit requires authentication', async () => {
      const body = await gql(server(), TEST_CREDIT);
      expect(body.errors?.[0]).toMatchObject({
        message: 'Authentication required',
        extensions: { code: 'UNAUTHENTICATED' },
      });
    });

    it('testCredit rejects an unknown currency before reaching the stub', async () => {
      const body = await gql(
        server(),
        'mutation { testCredit(currency: BTC, amount: "1") { amount } }',
        DEV_USER,
      );
      expect(body.errors).toHaveLength(1);
      expect(body.errors?.[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
    });

    it('testCredit is forbidden for staff', async () => {
      const body = await gql(server(), TEST_CREDIT, STAFF);
      expect(body.errors?.[0].extensions.code).toBe('FORBIDDEN');
    });

    it('balanceChanged requires authentication', async () => {
      await expect(
        subscribeError('subscription { balanceChanged { currency } }'),
      ).resolves.toMatchObject({
        message: 'Authentication required',
        extensions: { code: 'UNAUTHENTICATED' },
      });
    });

    it('balanceChanged reaches the stub for a logged-in user', async () => {
      await expect(
        subscribeError('subscription { balanceChanged { currency } }', DEV_USER),
      ).resolves.toMatchObject({ message: 'balanceChanged is not implemented yet' });
    });

    it('balanceChanged is forbidden for staff', async () => {
      await expect(
        subscribeError('subscription { balanceChanged { currency } }', STAFF),
      ).resolves.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    });

    it('takes the owner from the token: no userId argument anywhere', async () => {
      const body = await gql(
        server(),
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

    // The authentication guard runs before the handler, so "not found" is only for logged-in callers.
    it('asks an anonymous caller to log in on kvitka-uat instead of answering NOT_FOUND', async () => {
      app = await createApp({ APP_ENV: 'kvitka-uat', DEV_AUTH: 'false' });
      const body = await gql(app, TEST_CREDIT);
      expect(body.errors?.[0]).toMatchObject({
        message: 'Authentication required',
        extensions: { code: 'UNAUTHENTICATED' },
      });
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
