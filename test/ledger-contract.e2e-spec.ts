import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { createClient, type Client } from 'graphql-ws';
import { Redis } from 'ioredis';
import type { Knex } from 'knex';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import WebSocket from 'ws';
import { TokenService } from '../src/auth/tokens.js';
import { createKnex } from '../src/database/database.module.js';
import { eventChannel } from '../src/events/event-bus.js';
import { createApp } from './create-app.js';

/**
 * Ledger GraphQL contract on the real application (real MySQL and Redis, `npm run infra:up && npm run migrate`):
 * who may call which operation, what each one returns, and the live `balanceChanged` stream over graphql-ws.
 * Every user is new, so balances start at zero; the ledger rows the test writes are removed afterwards and
 * the funding balances are put back.
 */
describe('ledger contract (e2e)', () => {
  const USER_ID = '00000000-0000-4000-8000-000000000001';
  // A staff token carries no `wallet` permission; `bo` is how dev auth makes a staff caller.
  const STAFF = 'Dev 1:bo';
  const TEST_CREDIT = 'mutation { testCredit(currency: UAH, amount: "10050") { currency amount } }';
  const BALANCE_CHANGED = 'subscription { balanceChanged { currency amount decimals } }';
  const BALANCES = '{ balances { currency amount decimals } }';
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const channel = eventChannel('local', 'balance.changed');
  const userIds: string[] = [];
  let db: Knex;
  let redis: Redis;

  interface GqlError {
    message: string;
    extensions: { code: string; field?: string };
  }

  interface GqlBody {
    data?: Record<string, unknown> | null;
    errors?: GqlError[];
  }

  interface FieldInfo {
    name: string;
    args: { name: string }[];
  }

  interface BalanceRow {
    currency: string;
    amount: string;
    decimals: number;
  }

  /** A user nobody has used yet, as the dev-auth header: `Dev <uuid>:wallet`. */
  const newUser = (): { id: string; authorization: string } => {
    const id = randomUUID();
    userIds.push(id);
    return { id, authorization: `Dev ${id}:wallet` };
  };

  const gql = async (
    app: INestApplication,
    query: string,
    authorization?: string,
  ): Promise<GqlBody> => {
    const req = request(app.getHttpServer() as App).post('/graphql');
    if (authorization) req.set('Authorization', authorization);
    return (await req.send({ query })).body as GqlBody;
  };

  const creditQuery = (currency: string, amount: string): string =>
    `mutation { testCredit(currency: ${currency}, amount: "${amount}") { currency amount decimals } }`;

  const jwt = (app: INestApplication): string => {
    const subject = { userId: USER_ID, aud: 'wallet' as const, permissions: ['wallet'] };
    return `Bearer ${app.get(TokenService).signAccessToken(subject, new Date()).token}`;
  };

  const waitFor = async (
    condition: () => Promise<boolean> | boolean,
    ms: number,
  ): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`Condition not met within ${ms} ms`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  /** How many handlers the app has on the `balance.changed` channel (one Redis SUBSCRIBE for all of them). */
  const subscriberCount = async (): Promise<number> => {
    const [, count] = (await redis.pubsub('NUMSUB', channel)) as [string, number];
    return Number(count);
  };

  /** Undoes everything the tests wrote: entries, operations, user accounts, and the funding balances. */
  const cleanUp = async (): Promise<void> => {
    await db.transaction(async (trx) => {
      const ownIds = (await trx('accounts').whereIn('user_id', userIds).pluck('id')) as string[];
      const operationIds = (await trx('entries')
        .whereIn('account_id', ownIds)
        .distinct()
        .pluck('operation_id')) as string[];

      // Every operation of a test moves money between a test user and `funding`.
      const foreign = await trx('entries')
        .whereIn('operation_id', operationIds)
        .whereNotIn('account_id', ownIds)
        .groupBy('account_id')
        .select<{ account_id: string; total: string }[]>(
          'account_id',
          trx.raw('CAST(SUM(amount) AS CHAR) AS total'),
        );
      for (const { account_id, total } of foreign) {
        await trx('accounts')
          .where({ id: account_id })
          .update({ balance: trx.raw('balance - ?', [total]) });
      }

      await trx('entries').whereIn('operation_id', operationIds).delete();
      await trx('operations').whereIn('id', operationIds).delete();
      await trx('accounts').whereIn('id', ownIds).delete();
    });
  };

  beforeAll(() => {
    db = createKnex(process.env.DATABASE_URL!);
    redis = new Redis(redisUrl);
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await redis.quit();
      await db.destroy();
    }
  });

  describe('on APP_ENV=local with dev auth', () => {
    let app: INestApplication | undefined;
    let wsUrl: string;
    const clients: Client[] = [];

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

    afterEach(async () => {
      for (const client of clients.splice(0)) await client.dispose();
      // A leaked handler would keep the channel subscribed: every test leaves the app as it found it.
      await waitFor(async () => (await subscriberCount()) === 0, 2000);
    });

    afterAll(async () => {
      await app?.close();
    });

    const newClient = (authorization?: string): Client => {
      const client = createClient({
        url: wsUrl,
        webSocketImpl: WebSocket,
        retryAttempts: 0,
        connectionParams: authorization ? { Authorization: authorization } : {},
      });
      clients.push(client);
      return client;
    };

    /** First error of a subscription; fails if it delivers data. A resolver error arrives as a result with `errors`. */
    const subscribeError = async (query: string, authorization?: string): Promise<GqlError> =>
      new Promise<GqlError>((resolve, reject) => {
        newClient(authorization).subscribe(
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

    interface Listener {
      /** One entry per message, each the list of balances it carried. */
      received: BalanceRow[][];
      unsubscribe: () => void;
      dispose: () => void | Promise<void>;
    }

    // An amount no real balance has. The app registers one Redis handler per subscription but subscribes
    // the channel once, so the subscriber count cannot tell when the second client is ready; a probe can.
    const PROBE_AMOUNT = '-1';

    /** Subscribes to `balanceChanged` and returns once the app delivers to this client (probes are not kept). */
    const listen = async (user: { id: string; authorization: string }): Promise<Listener> => {
      const client = newClient(user.authorization);
      const received: BalanceRow[][] = [];
      let ready = false;
      const unsubscribe = client.subscribe<{ balanceChanged: BalanceRow[] }>(
        { query: BALANCE_CHANGED },
        {
          next: (result) => {
            const balances = result.data?.balanceChanged;
            if (!balances) return;
            if (balances[0].amount === PROBE_AMOUNT) ready = true;
            else received.push(balances);
          },
          error: () => undefined,
          complete: () => undefined,
        },
      );
      const probe = JSON.stringify({
        meta: {},
        payload: {
          v: 1,
          operationId: 'probe',
          userId: user.id,
          balances: [{ currency: 'UAH', amount: PROBE_AMOUNT }],
          occurredAt: new Date().toISOString(),
        },
      });
      await waitFor(async () => {
        await redis.publish(channel, probe);
        return ready;
      }, 2000);
      return { received, unsubscribe, dispose: () => client.dispose() };
    };

    const credit = async (
      authorization: string,
      currency: string,
      amount: string,
    ): Promise<BalanceRow> => {
      const body = await gql(server(), creditQuery(currency, amount), authorization);
      expect(body.errors).toBeUndefined();
      return (body.data as { testCredit: BalanceRow }).testCredit;
    };

    it('balances requires authentication', async () => {
      const body = await gql(server(), BALANCES);
      expect(body.errors?.[0]).toMatchObject({
        message: 'Authentication required',
        extensions: { code: 'UNAUTHENTICATED' },
      });
    });

    it('balances of a new user: five zeros in the order UAH, USD, EUR, PLN, USDT, with decimals', async () => {
      const body = await gql(server(), BALANCES, newUser().authorization);
      expect(body.errors).toBeUndefined();
      expect(body.data).toEqual({
        balances: [
          { currency: 'UAH', amount: '0', decimals: 2 },
          { currency: 'USD', amount: '0', decimals: 2 },
          { currency: 'EUR', amount: '0', decimals: 2 },
          { currency: 'PLN', amount: '0', decimals: 2 },
          { currency: 'USDT', amount: '0', decimals: 6 },
        ],
      });
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

    it('testCredit rejects an unknown currency in validation', async () => {
      const body = await gql(
        server(),
        'mutation { testCredit(currency: BTC, amount: "1") { amount } }',
        newUser().authorization,
      );
      expect(body.errors).toHaveLength(1);
      expect(body.errors?.[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
    });

    it('testCredit is forbidden for staff', async () => {
      const body = await gql(server(), TEST_CREDIT, STAFF);
      expect(body.errors?.[0].extensions.code).toBe('FORBIDDEN');
    });

    it('testCredit returns the new total of that currency, and a second call adds up', async () => {
      const { authorization } = newUser();

      await expect(credit(authorization, 'UAH', '10050')).resolves.toEqual({
        currency: 'UAH',
        amount: '10050',
        decimals: 2,
      });
      await expect(credit(authorization, 'UAH', '50')).resolves.toEqual({
        currency: 'UAH',
        amount: '10100',
        decimals: 2,
      });
      await expect(credit(authorization, 'USDT', '2500000')).resolves.toEqual({
        currency: 'USDT',
        amount: '2500000',
        decimals: 6,
      });

      const body = await gql(server(), BALANCES, authorization);
      expect(body.data).toEqual({
        balances: [
          { currency: 'UAH', amount: '10100', decimals: 2 },
          { currency: 'USD', amount: '0', decimals: 2 },
          { currency: 'EUR', amount: '0', decimals: 2 },
          { currency: 'PLN', amount: '0', decimals: 2 },
          { currency: 'USDT', amount: '2500000', decimals: 6 },
        ],
      });
    });

    it('testCredit credits only the caller', async () => {
      const [first, second] = [newUser(), newUser()];
      await credit(first.authorization, 'UAH', '700');

      const body = await gql(server(), BALANCES, second.authorization);
      expect((body.data as { balances: BalanceRow[] }).balances[0].amount).toBe('0');
    });

    it('testCredit accepts exactly 1 000 000 units', async () => {
      await expect(credit(newUser().authorization, 'UAH', '100000000')).resolves.toMatchObject({
        amount: '100000000',
      });
    });

    it.each(['0', '-1', '1.5', 'abc', '100000001'])(
      'testCredit rejects the amount "%s" with BAD_USER_INPUT on the amount field',
      async (amount) => {
        const { authorization } = newUser();

        const body = await gql(server(), creditQuery('UAH', amount), authorization);

        expect(body.errors).toHaveLength(1);
        expect(body.errors?.[0].extensions).toMatchObject({
          code: 'BAD_USER_INPUT',
          field: 'amount',
        });
        const balances = await gql(server(), BALANCES, authorization);
        expect((balances.data as { balances: BalanceRow[] }).balances[0].amount).toBe('0');
      },
    );

    it('balanceChanged requires authentication', async () => {
      await expect(subscribeError(BALANCE_CHANGED)).resolves.toMatchObject({
        message: 'Authentication required',
        extensions: { code: 'UNAUTHENTICATED' },
      });
    });

    it('balanceChanged is forbidden for staff', async () => {
      await expect(subscribeError(BALANCE_CHANGED, STAFF)).resolves.toMatchObject({
        extensions: { code: 'FORBIDDEN' },
      });
    });

    it('delivers the caller its own change within 1 s, with the full amount and decimals', async () => {
      const user = newUser();
      const listener = await listen(user);

      await credit(user.authorization, 'UAH', '10050');
      await waitFor(() => listener.received.length === 1, 1000);
      await credit(user.authorization, 'UAH', '50');
      await waitFor(() => listener.received.length === 2, 1000);

      expect(listener.received).toEqual([
        [{ currency: 'UAH', amount: '10050', decimals: 2 }],
        [{ currency: 'UAH', amount: '10100', decimals: 2 }],
      ]);
    });

    it('does not deliver the changes of another user', async () => {
      const [userA, userB] = [newUser(), newUser()];
      const [listenerA, listenerB] = [await listen(userA), await listen(userB)];

      await credit(userB.authorization, 'USDT', '3000000');
      await waitFor(() => listenerB.received.length === 1, 1000);
      // Events reach A in order, so once A has seen its own later change, B's would have arrived before it.
      await credit(userA.authorization, 'UAH', '100');
      await waitFor(() => listenerA.received.length >= 1, 1000);

      expect(listenerB.received).toEqual([[{ currency: 'USDT', amount: '3000000', decimals: 6 }]]);
      expect(listenerA.received).toEqual([[{ currency: 'UAH', amount: '100', decimals: 2 }]]);
    });

    it('removes the Redis handler when the client unsubscribes', async () => {
      const before = await subscriberCount();
      const listener = await listen(newUser());

      listener.unsubscribe();

      await waitFor(async () => (await subscriberCount()) === before, 1000);
    });

    it('removes the Redis handler when the client disconnects', async () => {
      const before = await subscriberCount();
      const listener = await listen(newUser());

      await listener.dispose();

      await waitFor(async () => (await subscriberCount()) === before, 1000);
    });

    it('takes the owner from the token: no userId argument anywhere', async () => {
      const body = await gql(
        server(),
        `{
          subscription: __type(name: "Subscription") { fields { name args { name } } }
          mutation: __type(name: "Mutation") { fields { name args { name } } }
        }`,
        newUser().authorization,
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
      const body = await gql(app, TEST_CREDIT, newUser().authorization);
      expect(body.data).toEqual({ testCredit: { currency: 'UAH', amount: '10050' } });
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
