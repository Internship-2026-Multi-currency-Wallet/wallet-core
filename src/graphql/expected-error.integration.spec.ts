import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  type CanActivate,
  Controller,
  Get,
  type INestApplication,
  Injectable,
  Module,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule, Query, Resolver, Subscription } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { GraphQLError } from 'graphql';
import { createClient, type FormattedExecutionResult } from 'graphql-ws';
import { LoggerModule, type PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import WebSocket from 'ws';
import { AppConfig } from '../config/app-config.js';
import { Metrics } from '../metrics/metrics.js';
import { httpLoggerOptions } from '../logging/logger.options.js';
import { tooManyRequestsError } from '../throttling/throttle-errors.js';
import { GraphqlErrorsModule } from './graphql-errors.module.js';
import { graphqlOptions } from './graphql.config.js';

/**
 * Error logging through a booted Nest + Apollo app with the real `graphqlOptions()`, access log and
 * filter module; pino, websocket and Nest logs are captured.
 */

const SECRET = 'secret-hash-e1-17';
const PRIVATE = 'review-private-db-message';
const LEAK = "Duplicate entry 'artem@test.com' for key 'users.users_email_unique'";

@Injectable()
class ThrottledGuard implements CanActivate {
  canActivate(): boolean {
    throw tooManyRequestsError(7);
  }
}

@Resolver()
class ProbeResolver {
  @UseGuards(ThrottledGuard)
  @Query(() => Boolean)
  guarded(): boolean {
    return true;
  }

  /** GraphQL itself fails to serialize this, after the resolver returned (outside Nest). */
  @Query(() => String)
  leakyString(): string {
    return { passwordHash: SECRET } as unknown as string;
  }

  /** One valid event, then the stream fails (outside Nest). */
  @Subscription(() => Boolean)
  async *flaky(): AsyncGenerator<{ flaky: boolean }> {
    yield { flaky: true };
    await Promise.resolve();
    throw new Error('ticker broke');
  }

  /** A plain Error tagged with a code: graphql-ws's wrapper inherits it, yet it is unexpected. */
  @Subscription(() => Boolean)
  async *taggedFailure(): AsyncGenerator<{ taggedFailure: boolean }> {
    yield { taggedFailure: true };
    await Promise.resolve();
    throw Object.assign(new Error(PRIVATE), { extensions: { code: 'BUSINESS_REFUSAL' } });
  }

  @Subscription(() => Boolean)
  async *codedFailure(): AsyncGenerator<{ codedFailure: boolean }> {
    yield { codedFailure: true };
    await Promise.resolve();
    throw new GraphQLError('Business refused', { extensions: { code: 'BUSINESS_REFUSAL' } });
  }

  @Subscription(() => Boolean)
  refused(): AsyncIterator<boolean> {
    throw new GraphQLError('Subscription refused', {
      extensions: { code: 'SUBSCRIPTION_REFUSED' },
    });
  }

  @Query(() => Boolean)
  throttled(): boolean {
    throw tooManyRequestsError(42);
  }

  @Query(() => Boolean)
  unlisted(): boolean {
    throw new GraphQLError('Out of stock', { extensions: { code: 'OUT_OF_STOCK' } });
  }

  @Query(() => Boolean)
  unauthorized(): boolean {
    throw new UnauthorizedException();
  }

  @Query(() => Boolean)
  crash(): boolean {
    throw new Error(LEAK);
  }

  @Query(() => Boolean)
  codeless(): boolean {
    throw new GraphQLError(LEAK);
  }
}

@Controller('probe')
class ProbeController {
  @Get('graphql-error')
  graphqlError(): never {
    throw new GraphQLError('on an HTTP route', { extensions: { code: 'X' } });
  }
}

interface PinoLine {
  level: string;
  msg: string;
  requestId?: string;
  code?: string;
  path?: string;
  operation?: string | null;
  status?: number;
  err?: { type: string; message: string; stack: string };
}

const pinoLog: PinoLine[] = [];
const nestLog: { level: string; args: unknown[] }[] = [];
/** What `graphqlOptions()` logged through its own logger: the websocket hooks. */
const wsLog: { level: string; fields: Record<string, unknown>; msg?: string }[] = [];

type WsResult = FormattedExecutionResult<Record<string, unknown>, unknown>;

describe('GraphQL error logging in Nest + Apollo', () => {
  let app: INestApplication;
  let wsUrl: string;
  const metrics = new Metrics({ service: 'wallet-core', env: 'local' });

  beforeAll(async () => {
    const config = AppConfig.fromEnv({ NODE_ENV: 'test' });
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          pinoLog.push(JSON.parse(line) as PinoLine);
        }
        done();
      },
    });
    const settings = {
      service: 'wallet-core',
      appEnv: 'local',
      client: 'demo',
      level: 'info',
      pretty: false,
    } as const;
    const record =
      (level: string) =>
      (fields: Record<string, unknown>, msg?: string): void => {
        wsLog.push({ level, fields, msg });
      };
    const wsLogger = {
      setContext: () => undefined,
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    } as unknown as PinoLogger;

    @Module({
      imports: [
        LoggerModule.forRoot({ pinoHttp: [httpLoggerOptions(settings), stream] }),
        GraphQLModule.forRoot<ApolloDriverConfig>({
          ...graphqlOptions(config, wsLogger, metrics),
          autoSchemaFile: true,
        }),
        GraphqlErrorsModule,
      ],
      controllers: [ProbeController],
      providers: [ProbeResolver, ThrottledGuard],
    })
    class TestModule {}

    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    const capture =
      (level: string) =>
      (...args: unknown[]): void => {
        nestLog.push({ level, args });
      };
    const noop = (): void => undefined;
    app = moduleRef.createNestApplication({
      logger: {
        log: noop,
        debug: noop,
        verbose: noop,
        warn: capture('warn'),
        error: capture('error'),
        fatal: capture('fatal'),
      },
    });
    await app.listen(0, '127.0.0.1');
    const { port } = (app.getHttpServer() as { address(): AddressInfo }).address();
    wsUrl = `ws://127.0.0.1:${port}/graphql`;
  });

  afterAll(async () => {
    await app.close();
  });

  async function run(field: string) {
    const requestId = `e1-17-${field}`;
    const before = nestLog.length;
    const res = await request(app.getHttpServer() as App)
      .post('/graphql')
      .set('x-request-id', requestId)
      .send({ query: `query Probe { ${field} }` });
    const lines = pinoLog.filter((line) => line.requestId === requestId);
    return {
      body: res.body as {
        errors: { message: string; path: string[]; extensions: Record<string, unknown> }[];
      },
      plugin: lines.filter((line) => line.msg.startsWith('GraphQL error')),
      access: lines.filter((line) => line.msg.startsWith('POST /graphql')),
      wsLines: wsLog.filter((entry) => entry.fields.requestId === requestId),
      nestErrors: nestLog.slice(before).filter((entry) => entry.level === 'error'),
    };
  }

  /** One operation over a real graphql-ws connection; the client is always disposed. */
  async function runWs(query: string, requestId: string, variables?: Record<string, unknown>) {
    const before = nestLog.length;
    const client = createClient({
      url: wsUrl,
      webSocketImpl: WebSocket,
      retryAttempts: 0,
      lazy: true,
      connectionParams: { 'x-request-id': requestId },
    });
    try {
      let failure: unknown;
      const results = await new Promise<WsResult[]>((resolve) => {
        const received: WsResult[] = [];
        client.subscribe(
          { query, variables },
          {
            next: (value) => received.push(value),
            error: (error) => {
              failure = error;
              resolve(received);
            },
            complete: () => resolve(received),
          },
        );
      });
      return {
        results,
        failure,
        warns: wsLog.filter((e) => e.level === 'warn' && e.fields.requestId === requestId),
        wsErrors: wsLog.filter((e) => e.level === 'error' && e.fields.requestId === requestId),
        nestErrors: nestLog.slice(before).filter((entry) => entry.level === 'error'),
      };
    } finally {
      await client.dispose();
    }
  }

  it.each([
    ['throttled', 'TOO_MANY_REQUESTS', 'Too many requests, try again later'],
    ['unlisted', 'OUT_OF_STOCK', 'Out of stock'],
  ])(
    '%s: one warn without a stack, no Nest ERROR, the code reaches the client',
    async (field, code, message) => {
      const { body, plugin, access, wsLines, nestErrors } = await run(field);

      expect(body.errors).toEqual([
        expect.objectContaining({
          message,
          path: [field],
          extensions: expect.objectContaining({ code }),
        }),
      ]);
      expect(plugin).toEqual([
        expect.objectContaining({ level: 'warn', code, path: field, operation: 'Probe' }),
      ]);
      expect(plugin[0].err).toBeUndefined();
      expect(wsLines).toEqual([]);
      expect(nestErrors).toEqual([]);
      expect(access).toEqual([
        expect.objectContaining({ level: 'info', status: 200, operation: 'query Probe' }),
      ]);
    },
  );

  it('keeps a Nest 4xx exception at warn without a Nest ERROR', async () => {
    const { body, plugin, nestErrors } = await run('unauthorized');
    expect(body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
    expect(plugin).toEqual([expect.objectContaining({ level: 'warn', code: 'HTTP_401' })]);
    expect(nestErrors).toEqual([]);
  });

  it.each([
    ['crash', 'Error'],
    ['codeless', 'GraphQLError'],
  ])(
    '%s: ERROR with the stack from the plugin and Nest, masked for the client',
    async (field, type) => {
      const { body, plugin, access, nestErrors } = await run(field);

      expect(body.errors).toEqual([
        {
          message: 'Internal server error',
          locations: expect.any(Array),
          path: [field],
          extensions: { code: 'INTERNAL_SERVER_ERROR' },
        },
      ]);
      expect(JSON.stringify(body)).not.toContain('artem@test.com');
      expect(plugin).toEqual([
        expect.objectContaining({ level: 'error', code: 'INTERNAL_SERVER_ERROR', path: field }),
      ]);
      expect(plugin[0].err).toMatchObject({
        type,
        message: LEAK,
        stack: expect.stringContaining('ProbeResolver'),
      });
      expect(nestErrors).toHaveLength(1);
      expect(nestErrors[0].args).toEqual(expect.arrayContaining(['ExceptionsHandler']));
      expect(access).toEqual([expect.objectContaining({ level: 'info', status: 200 })]);
    },
  );

  it('leaves a GraphQLError on an HTTP route to Nest: 500 and ERROR', async () => {
    const before = nestLog.length;
    await request(app.getHttpServer() as App)
      .get('/probe/graphql-error')
      .expect(500, { statusCode: 500, message: 'Internal server error' });
    expect(nestLog.slice(before)).toEqual([
      expect.objectContaining({
        level: 'error',
        args: expect.arrayContaining(['ExceptionsHandler']),
      }),
    ]);
  });

  describe('over graphql-ws', () => {
    it.each([
      ['a coded resolver failure', 'query Probe { throttled }', 'throttled', 'TOO_MANY_REQUESTS'],
      ['a coded guard failure', 'query Probe { guarded }', 'guarded', 'TOO_MANY_REQUESTS'],
      [
        'a subscription setup failure',
        'subscription Refused { refused }',
        'refused',
        'SUBSCRIPTION_REFUSED',
      ],
    ])('%s: one warn without err, no Nest ERROR', async (_case, query, field, code) => {
      const requestId = `e1-17-ws-${field}`;
      const { results, warns, wsErrors, nestErrors } = await runWs(query, requestId);

      expect(results).toEqual([
        expect.objectContaining({
          errors: [
            expect.objectContaining({
              path: [field],
              extensions: expect.objectContaining({ code }),
            }),
          ],
        }),
      ]);
      expect(warns).toEqual([
        {
          level: 'warn',
          fields: { requestId, code, path: field },
          msg: expect.stringMatching(/^GraphQL error: /),
        },
      ]);
      expect(wsErrors).toEqual([]);
      expect(nestErrors).toEqual([]);
    });

    it('logs a resolver exception at ERROR next to Nest’s own record, masked', async () => {
      const { results, failure, warns, wsErrors, nestErrors } = await runWs(
        'query Probe { crash }',
        'e1-17-ws-crash',
      );

      expect(results).toEqual([
        expect.objectContaining({
          errors: [
            expect.objectContaining({
              message: 'Internal server error',
              extensions: { code: 'INTERNAL_SERVER_ERROR' },
            }),
          ],
        }),
      ]);
      expect(failure).toBeUndefined();
      expect(warns).toEqual([]);
      expect(wsErrors).toEqual([
        expect.objectContaining({
          fields: expect.objectContaining({ code: 'INTERNAL_SERVER_ERROR', path: 'crash' }),
        }),
      ]);
      expect(nestErrors).toEqual([
        expect.objectContaining({ args: expect.arrayContaining(['ExceptionsHandler']) }),
      ]);
    });

    /** The line as pino would write it: the Error's message and stack included. */
    const serialized = (entry: (typeof wsLog)[number]) => {
      const err = entry.fields.err as Error;
      return JSON.stringify({
        ...entry,
        fields: { ...entry.fields, err: { message: err.message, stack: err.stack } },
      });
    };

    it('logs a serialization failure at ERROR with a redacted stack, masked', async () => {
      const requestId = 'e1-17-ws-serialization';
      const { results, failure, warns, wsErrors, nestErrors } = await runWs(
        'query Probe { leakyString }',
        requestId,
      );

      expect(failure).toBeUndefined();
      expect(results).toEqual([
        {
          data: null,
          errors: [
            {
              message: 'Internal server error',
              locations: expect.any(Array),
              path: ['leakyString'],
              extensions: { code: 'INTERNAL_SERVER_ERROR' },
            },
          ],
        },
      ]);
      expect(warns).toEqual([]);
      expect(wsErrors).toEqual([
        {
          level: 'error',
          fields: {
            requestId,
            code: 'INTERNAL_SERVER_ERROR',
            path: 'leakyString',
            err: expect.any(Error),
          },
          msg: 'GraphQL error: String cannot represent value: [REDACTED]',
        },
      ]);
      const err = wsErrors[0].fields.err as Error;
      expect(err.stack).toMatch(
        /^GraphQLError: String cannot represent value: \[REDACTED\]\n\s+at /,
      );
      expect(serialized(wsErrors[0])).not.toContain(SECRET);
      expect(nestErrors).toEqual([]);
    });

    /** The `graphql_errors_total` codes counted for a websocket operation. */
    async function countedCodes(operation: string): Promise<string[]> {
      const { values } = await metrics.graphqlErrors.get();
      return values
        .filter((v) => v.labels.operation === operation)
        .map((v) => String(v.labels.code));
    }

    it('masks a stream failure from a plain Error tagged with a code, ERROR with its stack', async () => {
      const requestId = 'e1-17-ws-tagged';
      const { results, failure, warns, wsErrors, nestErrors } = await runWs(
        'subscription Tagged { taggedFailure }',
        requestId,
      );

      expect(results).toEqual([{ data: { taggedFailure: true } }]);
      expect(failure).toEqual([
        { message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
      ]);
      expect(JSON.stringify(failure)).not.toContain(PRIVATE);
      expect(JSON.stringify(failure)).not.toContain('BUSINESS_REFUSAL');
      expect(warns).toEqual([]);
      expect(wsErrors).toEqual([
        {
          level: 'error',
          fields: {
            requestId,
            code: 'INTERNAL_SERVER_ERROR',
            path: undefined,
            err: expect.any(Error),
          },
          msg: expect.any(String),
        },
      ]);
      const err = wsErrors[0].fields.err as Error;
      expect(err.message).toBe(PRIVATE);
      expect(err.stack).toContain('ProbeResolver.taggedFailure');
      expect(nestErrors).toEqual([]);
      expect(await countedCodes('subscription taggedFailure')).toEqual(['INTERNAL_SERVER_ERROR']);
    });

    it('keeps a stream failure from a coded GraphQLError: one warn without err', async () => {
      const requestId = 'e1-17-ws-coded';
      const { results, failure, warns, wsErrors, nestErrors } = await runWs(
        'subscription Coded { codedFailure }',
        requestId,
      );

      expect(results).toEqual([{ data: { codedFailure: true } }]);
      expect(failure).toEqual([
        { message: 'Business refused', extensions: { code: 'BUSINESS_REFUSAL' } },
      ]);
      expect(warns).toEqual([
        {
          level: 'warn',
          fields: { requestId, code: 'BUSINESS_REFUSAL', path: undefined },
          msg: 'GraphQL error: Business refused',
        },
      ]);
      expect(wsErrors).toEqual([]);
      expect(nestErrors).toEqual([]);
      expect(await countedCodes('subscription codedFailure')).toEqual(['BUSINESS_REFUSAL']);
    });

    it('keeps the first event and logs the stream failure at ERROR with the stack, masked', async () => {
      const requestId = 'e1-17-ws-stream';
      const { results, failure, warns, wsErrors, nestErrors } = await runWs(
        'subscription Flaky { flaky }',
        requestId,
      );

      expect(results).toEqual([{ data: { flaky: true } }]);
      expect(failure).toEqual([
        { message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
      ]);
      expect(warns).toEqual([]);
      expect(wsErrors).toEqual([
        {
          level: 'error',
          fields: {
            requestId,
            code: 'INTERNAL_SERVER_ERROR',
            path: undefined,
            err: expect.any(Error),
          },
          msg: 'GraphQL error: ticker broke',
        },
      ]);
      const err = wsErrors[0].fields.err as Error;
      expect(err.message).toBe('ticker broke');
      expect(err.stack).toContain('ProbeResolver.flaky');
      expect(nestErrors).toEqual([]);
    });

    it.each([
      ['a validation error', '{ nope }', undefined],
      [
        'a variable of the wrong type',
        'query V($b: Boolean!) { __typename @include(if: $b) }',
        { b: 'yes' },
      ],
      ['a Nest 4xx exception', 'query Probe { unauthorized }', undefined],
    ])('does not log %s from the client', async (_case, query, variables) => {
      const requestId = `e1-17-ws-client-${query.length}`;
      const { results, failure, warns, wsErrors } = await runWs(query, requestId, variables);

      expect([
        ...results.flatMap((r) => r.errors ?? []),
        ...((failure as unknown[]) ?? []),
      ]).not.toHaveLength(0);
      expect(warns).toEqual([]);
      expect(wsErrors).toEqual([]);
    });
  });
});
