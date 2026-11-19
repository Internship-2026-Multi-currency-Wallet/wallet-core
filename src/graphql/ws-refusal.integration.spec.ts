import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { APP_GUARD } from '@nestjs/core';
import { Int, GraphQLModule, Query, Resolver, Subscription } from '@nestjs/graphql';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { createClient, type FormattedExecutionResult } from 'graphql-ws';
import { InjectPinoLogger, LoggerModule, PinoLogger } from 'nestjs-pino';
import WebSocket from 'ws';
import { AUTH_STRATEGIES } from '../auth/auth-strategy.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { Authenticator } from '../auth/authenticator.js';
import { JwtAuthStrategy } from '../auth/jwt-auth.strategy.js';
import { AppConfig } from '../config/app-config.js';
import { httpLoggerOptions } from '../logging/logger.options.js';
import { PermissionGuard } from '../permissions/permission.guard.js';
import { RequirePermission } from '../permissions/require-permission.decorator.js';
import { GraphqlErrorsModule } from './graphql-errors.module.js';
import { graphqlOptions } from './graphql.config.js';

/**
 * E1-18: refusals over a real graphql-ws connection, with the real guards, JWT strategy and the
 * production GraphQL logger, all writing to one pino stream.
 */

const config = AppConfig.fromEnv({ NODE_ENV: 'test' });
const USER_ID = '3c7e1a9b-5d2f-4b8e-9a6c-1f0d2e3b4a5c';

@Resolver()
class ProbeResolver {
  constructor(@InjectPinoLogger(ProbeResolver.name) private readonly logger: PinoLogger) {}

  @RequirePermission('wallet')
  @Query(() => Boolean)
  walletOnly(): boolean {
    return true;
  }

  @RequirePermission('bo:users')
  @Query(() => Boolean)
  staffOnly(): boolean {
    return true;
  }

  @RequirePermission('wallet')
  @Subscription(() => Int)
  ticks(): AsyncGenerator<{ ticks: number }> {
    this.logger.info('ticks subscribed');
    const logger = this.logger;
    return (async function* () {
      for (const tick of [1, 2]) {
        await Promise.resolve();
        logger.info({ tick }, 'tick produced');
        yield { ticks: tick };
      }
    })();
  }

  /** Runs until the client unsubscribes, which reaches it as `return()`. */
  @RequirePermission('wallet')
  @Subscription(() => Int)
  endless(): AsyncGenerator<{ endless: number }> {
    const logger = this.logger;
    return (async function* () {
      try {
        for (let tick = 1; ; tick += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          yield { endless: tick };
        }
      } finally {
        logger.info('endless stopped');
      }
    })();
  }
}

interface PinoLine {
  level: string;
  msg: string;
  context?: string;
  requestId?: string;
  code?: string;
  path?: string;
  err?: unknown;
  reason?: string;
  /** The line as pino wrote it. */
  raw: string;
}

const lines: PinoLine[] = [];
const nestErrors: unknown[][] = [];

type WsResult = FormattedExecutionResult<Record<string, unknown>, unknown>;

describe('WebSocket refusals (E1-18)', () => {
  let app: INestApplication;
  let wsUrl: string;

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
      service: 'wallet-core',
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
            ...graphqlOptions(config, logger),
            autoSchemaFile: true,
          }),
        }),
        GraphqlErrorsModule,
        JwtModule.register({}),
      ],
      providers: [
        ProbeResolver,
        { provide: AppConfig, useValue: config },
        JwtAuthStrategy,
        {
          provide: AUTH_STRATEGIES,
          inject: [JwtAuthStrategy],
          useFactory: (jwt: JwtAuthStrategy) => [jwt],
        },
        Authenticator,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
      ],
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

  const token = (permissions: string[]): string =>
    new JwtService().sign(
      { sub: USER_ID, aud: 'wallet', permissions },
      {
        secret: config.jwt.secret,
        algorithm: 'HS256',
        issuer: config.jwt.issuer,
        expiresIn: 60,
      },
    );

  /** One operation over its own connection; returns what the client got and the new log lines. */
  async function runWs(query: string, requestId: string, authorization: string) {
    const before = lines.length;
    const nestBefore = nestErrors.length;
    const client = createClient({
      url: wsUrl,
      webSocketImpl: WebSocket,
      retryAttempts: 0,
      lazy: true,
      connectionParams: { 'x-request-id': requestId, Authorization: authorization },
    });
    try {
      let failure: unknown;
      const results = await new Promise<WsResult[]>((resolve) => {
        const received: WsResult[] = [];
        client.subscribe(
          { query },
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
        logs: lines.slice(before),
        nestErrors: nestErrors.slice(nestBefore),
      };
    } finally {
      await client.dispose();
    }
  }

  describe('invalid JWT', () => {
    const run = (requestId: string) =>
      runWs('query Probe { walletOnly }', requestId, 'Bearer not-a-jwt');

    it('baseline: the client gets UNAUTHENTICATED with the path', async () => {
      const { results, failure } = await run('e1-18-jwt-response');
      expect(failure).toBeUndefined();
      expect(results).toEqual([
        {
          data: null,
          errors: [
            {
              message: 'Invalid access token',
              locations: [{ line: 1, column: 15 }],
              path: ['walletOnly'],
              extensions: { code: 'UNAUTHENTICATED' },
            },
          ],
        },
      ]);
    });

    it('the strategy WARN carries the connection requestId', async () => {
      const requestId = 'e1-18-jwt-strategy';
      const { logs } = await run(requestId);
      const strategy = logs.filter((line) => line.context === 'JwtAuthStrategy');
      expect(strategy).toEqual([
        expect.objectContaining({ level: 'warn', msg: 'access token rejected', requestId }),
      ]);
    });

    it('one GraphQL WARN with HTTP_401, path and requestId; no ERROR', async () => {
      const requestId = 'e1-18-jwt-graphql';
      const { logs, nestErrors: nest } = await run(requestId);
      expect(logs.filter((line) => line.context === 'GraphQL' && line.level !== 'info')).toEqual([
        expect.objectContaining({ level: 'warn', code: 'HTTP_401', path: 'walletOnly', requestId }),
      ]);
      expect(logs.filter((line) => line.level === 'error')).toEqual([]);
      expect(nest).toEqual([]);
    });

    it('writes the requestId once per raw line', async () => {
      const requestId = 'e1-18-jwt-raw';
      const { logs } = await run(requestId);
      const refusal = logs.filter((line) => line.level === 'warn');
      expect(refusal.map((line) => line.context)).toEqual(['JwtAuthStrategy', 'GraphQL']);
      for (const line of refusal) expect(line.raw.split('"requestId"')).toHaveLength(2);
    });

    it('keeps the requestIds of two concurrent connections apart', async () => {
      const wrongSecret = new JwtService().sign(
        { sub: USER_ID, aud: 'wallet', permissions: ['wallet'] },
        { secret: 'not-the-secret', algorithm: 'HS256', issuer: config.jwt.issuer },
      );
      const [malformed, forged] = await Promise.all([
        runWs('query Probe { walletOnly }', 'e1-18-concurrent-a', 'Bearer not-a-jwt'),
        runWs('query Probe { walletOnly }', 'e1-18-concurrent-b', `Bearer ${wrongSecret}`),
      ]);
      const ofConnection = (logs: PinoLine[], requestId: string) =>
        logs
          .filter((line) => line.requestId === requestId && line.level === 'warn')
          .map(({ context, reason, code }) => ({ context, reason, code }));

      expect(ofConnection(malformed.logs, 'e1-18-concurrent-a')).toEqual([
        { context: 'JwtAuthStrategy', reason: 'jwt malformed', code: undefined },
        { context: 'GraphQL', reason: undefined, code: 'HTTP_401' },
      ]);
      expect(ofConnection(forged.logs, 'e1-18-concurrent-b')).toEqual([
        { context: 'JwtAuthStrategy', reason: 'invalid signature', code: undefined },
        { context: 'GraphQL', reason: undefined, code: 'HTTP_401' },
      ]);
    });
  });

  describe('missing permission', () => {
    const run = (requestId: string) =>
      runWs('query Probe { staffOnly }', requestId, `Bearer ${token(['wallet'])}`);

    it('baseline: the client gets FORBIDDEN with the path', async () => {
      const { results, failure } = await run('e1-18-perm-response');
      expect(failure).toBeUndefined();
      expect(results).toEqual([
        {
          data: null,
          errors: [
            {
              message: 'Missing permission: bo:users',
              locations: [{ line: 1, column: 15 }],
              path: ['staffOnly'],
              extensions: { code: 'FORBIDDEN' },
            },
          ],
        },
      ]);
    });

    it('one GraphQL WARN with HTTP_403, path and requestId; no ERROR', async () => {
      const requestId = 'e1-18-perm-graphql';
      const { logs, nestErrors: nest } = await run(requestId);
      expect(logs.filter((line) => line.context === 'GraphQL' && line.level !== 'info')).toEqual([
        expect.objectContaining({ level: 'warn', code: 'HTTP_403', path: 'staffOnly', requestId }),
      ]);
      expect(logs.filter((line) => line.level === 'error')).toEqual([]);
      expect(nest).toEqual([]);
    });
  });

  describe('a subscription', () => {
    const run = (requestId: string) =>
      runWs('subscription Ticks { ticks }', requestId, `Bearer ${token(['wallet'])}`);

    it('the log written when it is set up carries the requestId', async () => {
      const requestId = 'e1-18-sub-setup';
      const { results, logs } = await run(requestId);
      expect(results).toEqual([{ data: { ticks: 1 } }, { data: { ticks: 2 } }]);
      expect(logs.filter((line) => line.msg === 'ticks subscribed')).toEqual([
        expect.objectContaining({ requestId }),
      ]);
    });

    it('the logs written while producing each later event carry the requestId', async () => {
      const requestId = 'e1-18-sub-events';
      const { logs } = await run(requestId);
      expect(logs.filter((line) => line.msg === 'tick produced')).toEqual([
        expect.objectContaining({ requestId }),
        expect.objectContaining({ requestId }),
      ]);
    });

    it('stops the source when the client unsubscribes, logging with the requestId', async () => {
      const requestId = 'e1-18-sub-return';
      const client = createClient({
        url: wsUrl,
        webSocketImpl: WebSocket,
        retryAttempts: 0,
        lazy: true,
        connectionParams: {
          'x-request-id': requestId,
          Authorization: `Bearer ${token(['wallet'])}`,
        },
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const unsubscribe = client.subscribe(
            { query: 'subscription Endless { endless }' },
            { next: () => (unsubscribe(), resolve()), error: reject, complete: resolve },
          );
        });
        const stopped = () => lines.filter((line) => line.msg === 'endless stopped');
        for (let waited = 0; stopped().length === 0 && waited < 2000; waited += 10) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(stopped()).toEqual([expect.objectContaining({ requestId })]);
      } finally {
        await client.dispose();
      }
    });
  });
});
