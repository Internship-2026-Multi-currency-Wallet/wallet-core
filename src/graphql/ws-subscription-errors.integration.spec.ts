import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  ForbiddenException,
  type INestApplication,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import {
  Args,
  Field,
  GraphQLModule,
  Int,
  ObjectType,
  Query,
  Resolver,
  Subscription,
} from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { GraphQLError } from 'graphql';
import { type Client, createClient, type FormattedExecutionResult } from 'graphql-ws';
import { InjectPinoLogger, LoggerModule, PinoLogger } from 'nestjs-pino';
import WebSocket from 'ws';
import { AppConfig } from '../config/app-config.js';
import { httpLoggerOptions } from '../logging/logger.options.js';
import { Metrics } from '../metrics/metrics.js';
import { GraphqlErrorsModule } from './graphql-errors.module.js';
import { graphqlOptions } from './graphql.config.js';

/** The real case on `balanceChanged` is in `ledger/balance-changed-errors.integration.spec.ts`. */

const SERVICE = 'wallet-core';
const config = AppConfig.fromEnv({ NODE_ENV: 'test' });
const SECRET = 'artem@test.com';

const OUTCOMES: Record<string, () => number> = {
  ok: () => 1,
  crash: () => {
    throw new Error(`Duplicate entry '${SECRET}' for key 'users.email'`);
  },
  expected: () => {
    throw new GraphQLError('Amount is too large', { extensions: { code: 'BAD_USER_INPUT' } });
  },
  noCode: () => {
    throw new GraphQLError(`No code, ${SECRET}`);
  },
  numericCode: () => {
    throw new GraphQLError(`Numeric code, ${SECRET}`, { extensions: { code: 42 } });
  },
  copiedCode: () => {
    throw Object.assign(new Error(`Copied code, ${SECRET}`), {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  },
  notAnError: () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- what a careless library can do
    throw `thrown string, ${SECRET}`;
  },
  unknownCode: () => {
    throw new GraphQLError('Rate is stale', { extensions: { code: 'RATE_STALE' } });
  },
  forbidden: () => {
    throw new ForbiddenException('Not your wallet');
  },
  unavailable: () => {
    throw new ServiceUnavailableException('Try again later');
  },
};

@ObjectType()
class Pair {
  @Field(() => Int, { nullable: true })
  left?: number;

  @Field(() => Int, { nullable: true })
  right?: number;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Resolver()
class ProbeResolver {
  constructor(@InjectPinoLogger(ProbeResolver.name) private readonly logger: PinoLogger) {}

  @Query(() => Boolean)
  alive(): boolean {
    return true;
  }

  @Subscription(() => Int, {
    nullable: true,
    resolve: (event: { outcome: string }) => OUTCOMES[event.outcome](),
  })
  events(
    @Args('script', { type: () => [String] }) script: string[],
  ): AsyncGenerator<{ outcome: string }> {
    return (async function* () {
      for (const outcome of script) {
        await Promise.resolve();
        yield { outcome };
      }
    })();
  }

  @Subscription(() => Pair, { nullable: true, resolve: (pair: Pair) => pair })
  pairs(): AsyncGenerator<Pair> {
    return (async function* () {
      await Promise.resolve();
      yield {
        get left(): number {
          throw new Error(`left failed, ${SECRET}`);
        },
        get right(): number {
          throw new Error(`right failed, ${SECRET}`);
        },
      };
    })();
  }

  @Subscription(() => Int, { resolve: (event: number) => event })
  brokenSource(): AsyncGenerator<number> {
    return (async function* () {
      await Promise.resolve();
      yield 1;
      throw new Error(`Redis connection lost, ${SECRET}`);
    })();
  }

  @Subscription(() => Int, {
    nullable: true,
    resolve: () => OUTCOMES.crash(),
  })
  endlessCrash(): AsyncGenerator<number> {
    const logger = this.logger;
    return (async function* () {
      try {
        for (let tick = 1; ; tick += 1) {
          await pause(5);
          yield tick;
        }
      } finally {
        logger.info('endlessCrash stopped');
      }
    })();
  }
}

interface PinoLine {
  level: string;
  msg: string;
  context?: string;
  requestId?: string;
  subscriptionId?: string;
  operation?: string;
  code?: string;
  path?: string;
  err?: { type?: string; message?: string; stack?: string };
  raw: string;
}

const lines: PinoLine[] = [];
const nestErrors: unknown[][] = [];

type WsResult = FormattedExecutionResult<Record<string, unknown>, unknown>;

const errorRecords = (logs: PinoLine[]) =>
  logs.filter((line) => line.context === 'GraphQL' && ['warn', 'error'].includes(line.level));

describe(`errors in a running subscription (${SERVICE})`, () => {
  let app: INestApplication;
  let wsUrl: string;
  const metrics = new Metrics({ service: SERVICE, env: 'local' });

  beforeAll(async () => {
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          lines.push({ ...(JSON.parse(line) as Omit<PinoLine, 'raw'>), raw: line });
        }
        done();
      },
    });
    const settings = {
      service: SERVICE,
      appEnv: 'local',
      client: 'demo',
      level: 'info',
      pretty: false,
    } as const;
    const moduleRef = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ pinoHttp: [httpLoggerOptions(settings), stream] }),
        GraphQLModule.forRootAsync<ApolloDriverConfig>({
          driver: ApolloDriver,
          inject: [PinoLogger],
          useFactory: (logger: PinoLogger) => ({
            ...graphqlOptions(config, logger, metrics),
            autoSchemaFile: true,
          }),
        }),
        GraphqlErrorsModule,
      ],
      providers: [ProbeResolver],
    }).compile();
    const noop = (): void => undefined;
    app = moduleRef.createNestApplication({
      logger: {
        log: noop,
        debug: noop,
        verbose: noop,
        warn: noop,
        error: (...args: unknown[]) => nestErrors.push(args),
        fatal: (...args: unknown[]) => nestErrors.push(args),
      },
    });
    await app.listen(0, '127.0.0.1');
    const { port } = (app.getHttpServer() as { address(): AddressInfo }).address();
    wsUrl = `ws://127.0.0.1:${port}/graphql`;
  });

  afterAll(async () => {
    await app.close();
  });

  const connect = (requestId?: string): Client =>
    createClient({
      url: wsUrl,
      webSocketImpl: WebSocket,
      retryAttempts: 0,
      lazy: true,
      connectionParams: requestId ? { 'x-request-id': requestId } : {},
    });

  function collect(client: Client, query: string, operationName?: string) {
    return new Promise<{ results: WsResult[]; failure: unknown }>((resolve) => {
      const results: WsResult[] = [];
      client.subscribe(
        { query, operationName },
        {
          next: (value) => results.push(value),
          error: (failure) => resolve({ results, failure }),
          complete: () => resolve({ results, failure: undefined }),
        },
      );
    });
  }

  async function runWs(query: string, requestId?: string) {
    const before = lines.length;
    const nestBefore = nestErrors.length;
    const client = connect(requestId);
    try {
      const { results, failure } = await collect(client, query);
      return {
        results,
        failure,
        logs: lines.slice(before),
        nestErrors: nestErrors.slice(nestBefore),
      };
    } finally {
      await client.dispose();
    }
  }

  const script = (...outcomes: string[]) =>
    `subscription Script { events(script: ${JSON.stringify(outcomes)}) }`;

  async function errorCount(operation: string, code: string): Promise<number> {
    const { values } = await metrics.graphqlErrors.get();
    return (
      values.find((v) => v.labels.operation === operation && v.labels.code === code)?.value ?? 0
    );
  }

  describe('an unexpected error while resolving an event', () => {
    it('writes exactly one ERROR with operation, code, requestId, path and the stack', async () => {
      const requestId = 'sub-err-crash';
      const { logs, nestErrors: nest } = await runWs(script('ok', 'crash', 'ok'), requestId);
      expect(errorRecords(logs)).toEqual([
        expect.objectContaining({
          level: 'error',
          msg: `GraphQL error: Duplicate entry '${SECRET}' for key 'users.email'`,
          operation: 'subscription Script',
          subscriptionId: expect.any(String),
          code: 'INTERNAL_SERVER_ERROR',
          requestId,
          path: 'events',
          err: expect.objectContaining({
            type: 'Error',
            stack: expect.stringContaining('Duplicate entry'),
          }),
        }),
      ]);
      expect(logs.filter((line) => line.level === 'error')).toHaveLength(1);
      expect(nest).toEqual([]);
    });

    it('names the same subscription as its started/completed lines', async () => {
      const requestId = 'sub-err-lifecycle';
      const { logs } = await runWs(script('crash'), requestId);
      const lifecycle = logs.filter((line) => /started|completed$/.test(line.msg));
      const [error] = errorRecords(logs);
      expect(lifecycle).toHaveLength(2);
      for (const line of lifecycle) {
        expect(line).toMatchObject({
          requestId,
          operation: error.operation,
          subscriptionId: error.subscriptionId,
        });
      }
    });

    it('writes the requestId once per raw line', async () => {
      const { logs } = await runWs(script('crash'), 'sub-err-raw');
      const [error] = errorRecords(logs);
      expect(error.raw.split('"requestId"')).toHaveLength(2);
    });

    it('sends the client the masked error, keeps the other events and ends normally', async () => {
      const { results, failure } = await runWs(script('ok', 'crash', 'ok'), 'sub-err-masked');
      expect(failure).toBeUndefined();
      expect(results).toEqual([
        { data: { events: 1 } },
        {
          data: { events: null },
          errors: [
            {
              message: 'Internal server error',
              locations: [{ line: 1, column: 23 }],
              path: ['events'],
              extensions: { code: 'INTERNAL_SERVER_ERROR' },
            },
          ],
        },
        { data: { events: 1 } },
      ]);
      expect(JSON.stringify(results)).not.toContain(SECRET);
      expect(JSON.stringify(results)).not.toContain('stack');
    });

    it('counts the error in the metric exactly once', async () => {
      const operation = 'subscription events';
      const before = await errorCount(operation, 'INTERNAL_SERVER_ERROR');
      await runWs(script('ok', 'crash', 'ok'), 'sub-err-metric');
      expect(await errorCount(operation, 'INTERNAL_SERVER_ERROR')).toBe(before + 1);
    });

    it('writes one record per failed event, also when the first event fails', async () => {
      const { logs } = await runWs(script('crash', 'ok', 'crash'), 'sub-err-each');
      expect(errorRecords(logs).map((line) => line.level)).toEqual(['error', 'error']);
    });
  });

  describe('classification (E1-17)', () => {
    const recordFor = async (outcome: string) => {
      const { logs, results } = await runWs(script(outcome), `sub-err-${outcome}`);
      const records = errorRecords(logs);
      expect(records).toHaveLength(1);
      return { record: records[0], response: results[0] };
    };

    it('an expected GraphQLError with a code: one WARN without a stack, sent as thrown', async () => {
      const { record, response } = await recordFor('expected');
      expect(record).toMatchObject({
        level: 'warn',
        operation: 'subscription Script',
        code: 'BAD_USER_INPUT',
        requestId: 'sub-err-expected',
        path: 'events',
      });
      expect(record.err).toBeUndefined();
      expect(record.raw).not.toContain('stack');
      expect(response.errors).toEqual([
        expect.objectContaining({
          message: 'Amount is too large',
          extensions: { code: 'BAD_USER_INPUT' },
        }),
      ]);
    });

    it('any string code thrown on purpose counts as expected (the E1-17 rule)', async () => {
      const { record, response } = await recordFor('unknownCode');
      expect(record).toMatchObject({ level: 'warn', code: 'RATE_STALE' });
      expect(record.err).toBeUndefined();
      expect(response.errors).toEqual([
        expect.objectContaining({ message: 'Rate is stale', extensions: { code: 'RATE_STALE' } }),
      ]);
    });

    it.each(['noCode', 'numericCode', 'copiedCode', 'notAnError'])(
      '%s: unexpected, one ERROR with the stack, masked for the client',
      async (outcome) => {
        const { record, response } = await recordFor(outcome);
        expect(record).toMatchObject({
          level: 'error',
          code: 'INTERNAL_SERVER_ERROR',
          err: expect.objectContaining({ stack: expect.any(String) }),
        });
        expect(response.errors).toEqual([
          expect.objectContaining({
            message: 'Internal server error',
            extensions: { code: 'INTERNAL_SERVER_ERROR' },
          }),
        ]);
        expect(JSON.stringify(response)).not.toContain(SECRET);
      },
    );

    it('a Nest 4xx exception: one WARN with HTTP_<status>, without a stack', async () => {
      const { record } = await recordFor('forbidden');
      expect(record).toMatchObject({ level: 'warn', code: 'HTTP_403', path: 'events' });
      expect(record.err).toBeUndefined();
    });

    it('a Nest 5xx exception: one ERROR with the stack', async () => {
      const { record } = await recordFor('unavailable');
      expect(record).toMatchObject({ level: 'error', code: 'INTERNAL_SERVER_ERROR' });
      expect(record.err?.stack).toEqual(expect.any(String));
    });
  });

  it('successful events write no error records', async () => {
    const { logs, results } = await runWs(script('ok', 'ok', 'ok'), 'sub-err-none');
    expect(results).toHaveLength(3);
    expect(logs.filter((line) => line.level === 'warn' || line.level === 'error')).toEqual([]);
  });

  it('two errors in one result: one record each, by path; the metric counts the result once', async () => {
    const operation = 'subscription pairs';
    const before = await errorCount(operation, 'INTERNAL_SERVER_ERROR');
    const { logs, results } = await runWs(
      'subscription Pairs { pairs { left right } }',
      'sub-err-pair',
    );
    expect(
      errorRecords(logs).map(({ level, path, operation: name }) => ({ level, path, name })),
    ).toEqual([
      { level: 'error', path: 'pairs.left', name: 'subscription Pairs' },
      { level: 'error', path: 'pairs.right', name: 'subscription Pairs' },
    ]);
    expect(results[0].errors).toHaveLength(2);
    expect(JSON.stringify(results)).not.toContain(SECRET);
    expect(await errorCount(operation, 'INTERNAL_SERVER_ERROR')).toBe(before + 1);
  });

  it('a failing source: one ERROR with operation and requestId; the client gets it masked', async () => {
    const requestId = 'sub-err-source';
    const {
      logs,
      results,
      failure,
      nestErrors: nest,
    } = await runWs('subscription Broken { brokenSource }', requestId);
    expect(results).toEqual([{ data: { brokenSource: 1 } }]);
    expect(failure).toEqual([
      { message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
    ]);
    expect(errorRecords(logs)).toEqual([
      expect.objectContaining({
        level: 'error',
        operation: 'subscription Broken',
        code: 'INTERNAL_SERVER_ERROR',
        requestId,
        err: expect.objectContaining({ stack: expect.stringContaining('Redis connection lost') }),
      }),
    ]);
    expect(nest).toEqual([]);
  });

  it('names the operation the operationName selects, not the first one', async () => {
    const before = lines.length;
    const client = connect('sub-err-operation-name');
    try {
      await collect(
        client,
        'query Other { alive } subscription Chosen { events(script: ["crash"]) }',
        'Chosen',
      );
    } finally {
      await client.dispose();
    }
    const logs = lines.slice(before);
    expect(errorRecords(logs)).toEqual([
      expect.objectContaining({ operation: 'subscription Chosen' }),
    ]);
    expect(logs.map((line) => line.msg)).toEqual(
      expect.arrayContaining(['subscription Chosen started', 'subscription Chosen completed']),
    );
  });

  it('finds the name after a leading comment', async () => {
    const { logs } = await runWs(
      [
        '# sent by a client that keeps comments',
        'subscription Commented { events(script: ["crash"]) }',
      ].join('\n'),
      'sub-err-comment',
    );
    expect(errorRecords(logs)).toEqual([
      expect.objectContaining({ operation: 'subscription Commented' }),
    ]);
  });

  it('an anonymous operation is named by its first field', async () => {
    const { logs } = await runWs('subscription { events(script: ["crash"]) }', 'sub-err-anon');
    expect(errorRecords(logs)).toEqual([
      expect.objectContaining({ operation: 'subscription events' }),
    ]);
  });

  it('without an x-request-id each connection gets its own id, kept on all of its lines', async () => {
    const first = await runWs(script('crash'));
    const second = await runWs(script('crash'));
    const idOf = (logs: PinoLine[]) => {
      const ids = new Set(
        logs.filter((line) => line.context === 'GraphQL').map((l) => l.requestId),
      );
      expect(ids.size).toBe(1);
      return [...ids][0];
    };
    const [a, b] = [idOf(first.logs), idOf(second.logs)];
    expect(a).toEqual(expect.any(String));
    expect(b).toEqual(expect.any(String));
    expect(a).not.toBe(b);
  });

  it('two subscriptions on one connection keep their operation and subscriptionId apart', async () => {
    const requestId = 'sub-err-shared';
    const before = lines.length;
    const client = connect(requestId);
    try {
      await Promise.all([
        collect(client, 'subscription First { events(script: ["ok", "crash"]) }'),
        collect(client, 'subscription Second { events(script: ["crash", "ok"]) }'),
      ]);
    } finally {
      await client.dispose();
    }
    const logs = lines.slice(before);
    const startedId = (name: string) =>
      logs.find((line) => line.msg === `subscription ${name} started`)?.subscriptionId;
    const records = errorRecords(logs);
    expect(records).toHaveLength(2);
    expect(
      records.map(({ operation, subscriptionId, requestId: id }) => ({
        operation,
        subscriptionId,
        id,
      })),
    ).toEqual(
      expect.arrayContaining([
        { operation: 'subscription First', subscriptionId: startedId('First'), id: requestId },
        { operation: 'subscription Second', subscriptionId: startedId('Second'), id: requestId },
      ]),
    );
    expect(startedId('First')).not.toBe(startedId('Second'));
  });

  async function endAfterFirstError(requestId: string, end: 'unsubscribe' | 'disconnect') {
    const before = lines.length;
    const client = connect(requestId);
    let received = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const unsubscribe = client.subscribe(
          { query: 'subscription Endless { endlessCrash }' },
          {
            next: () => {
              received += 1;
              if (end === 'unsubscribe') unsubscribe();
              resolve();
            },
            error: reject,
            complete: resolve,
          },
        );
      });
    } finally {
      await client.dispose();
    }
    const stopped = () => lines.slice(before).filter((line) => line.msg === 'endlessCrash stopped');
    for (let waited = 0; stopped().length === 0 && waited < 2000; waited += 10) await pause(10);
    expect(stopped()).toHaveLength(1);
    const atStop = lines.length;
    await pause(50);
    return { logs: lines.slice(before), afterStop: lines.slice(atStop), received };
  }

  it.each(['unsubscribe', 'disconnect'] as const)(
    '%s right after an error: one record per failed event, nothing from ending it',
    async (end) => {
      const requestId = `sub-err-${end}`;
      const { logs, afterStop, received } = await endAfterFirstError(requestId, end);
      const records = errorRecords(logs);
      expect(received).toBe(1);
      // An event already resolved when the client went away is still logged, once.
      expect(records.length).toBeGreaterThanOrEqual(1);
      for (const record of records) {
        expect(record).toMatchObject({
          level: 'error',
          requestId,
          operation: 'subscription Endless',
          path: 'endlessCrash',
          msg: expect.stringContaining('Duplicate entry'),
        });
      }
      expect(logs.filter((line) => line.level === 'error')).toHaveLength(records.length);
      expect(afterStop.filter((line) => line.level === 'error' || line.level === 'warn')).toEqual(
        [],
      );
    },
  );
});
