import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { APP_GUARD } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { createClient, type FormattedExecutionResult } from 'graphql-ws';
import { LoggerModule, PinoLogger } from 'nestjs-pino';
import WebSocket from 'ws';
import { AUTH_STRATEGIES } from '../auth/auth-strategy.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { JwtAuthStrategy } from '../auth/jwt-auth.strategy.js';
import { AppConfig } from '../config/app-config.js';
import type { BalanceChangedEvent } from '../events/catalog.js';
import { EventSubscriber } from '../events/event-bus.js';
import { GraphqlErrorsModule } from '../graphql/graphql-errors.module.js';
import { graphqlOptions } from '../graphql/graphql.config.js';
import { httpLoggerOptions } from '../logging/logger.options.js';
import { Metrics } from '../metrics/metrics.js';
import { PermissionGuard } from '../permissions/permission.guard.js';
import { LedgerResolver } from './ledger.resolver.js';
import { LedgerService } from './ledger.service.js';

/**
 * The case the logging gap was found with: a malformed `balance.changed` event reaching a running
 * `balanceChanged` subscription, over a real graphql-ws connection with the real resolver, guards,
 * production logger and metrics. Redis is replaced by a subscriber the test publishes to.
 */

const config = AppConfig.fromEnv({ NODE_ENV: 'test' });
const USER_ID = '3c7e1a9b-5d2f-4b8e-9a6c-1f0d2e3b4a5c';

type Handler = (event: BalanceChangedEvent) => void;

class FakeSubscriber {
  readonly handlers = new Set<Handler>();

  subscribe(_name: 'balance.changed', handler: Handler): Promise<() => Promise<void>> {
    this.handlers.add(handler);
    return Promise.resolve(() => {
      this.handlers.delete(handler);
      return Promise.resolve();
    });
  }

  publish(balances: BalanceChangedEvent['balances']): void {
    const event = {
      v: 1,
      operationId: 'op-1',
      userId: USER_ID,
      balances,
      occurredAt: new Date().toISOString(),
    } as const;
    for (const handler of this.handlers) handler(event);
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
  err?: { type?: string; stack?: string };
}

const lines: PinoLine[] = [];
const nestErrors: unknown[][] = [];

type WsResult = FormattedExecutionResult<Record<string, unknown>, unknown>;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('balanceChanged: a malformed event', () => {
  let app: INestApplication;
  let wsUrl: string;
  const subscriber = new FakeSubscriber();
  const metrics = new Metrics({ service: 'wallet-core', env: 'local' });

  beforeAll(async () => {
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          lines.push(JSON.parse(line) as PinoLine);
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
            ...graphqlOptions(config, logger, metrics),
            autoSchemaFile: true,
          }),
        }),
        GraphqlErrorsModule,
        JwtModule.register({}),
      ],
      providers: [
        LedgerResolver,
        { provide: LedgerService, useValue: {} },
        { provide: EventSubscriber, useValue: subscriber },
        { provide: AppConfig, useValue: config },
        JwtAuthStrategy,
        {
          provide: AUTH_STRATEGIES,
          inject: [JwtAuthStrategy],
          useFactory: (jwt: JwtAuthStrategy) => [jwt],
        },
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

  const token = new JwtService().sign(
    { sub: USER_ID, aud: 'wallet', permissions: ['wallet'] },
    { secret: config.jwt.secret, algorithm: 'HS256', issuer: config.jwt.issuer, expiresIn: 60 },
  );

  it('writes one ERROR with operation, code, requestId and stack; the client gets it masked', async () => {
    const requestId = 'balance-changed-malformed';
    const before = lines.length;
    const nestBefore = nestErrors.length;
    const errorsBefore = (await metrics.graphqlErrors.get()).values.length;
    const client = createClient({
      url: wsUrl,
      webSocketImpl: WebSocket,
      retryAttempts: 0,
      lazy: true,
      connectionParams: { 'x-request-id': requestId, Authorization: `Bearer ${token}` },
    });
    const results: WsResult[] = [];
    try {
      const done = new Promise<void>((resolve, reject) => {
        const unsubscribe = client.subscribe(
          { query: 'subscription BalanceChanged { balanceChanged { currency amount version } }' },
          {
            next: (value) => {
              results.push(value);
              if (results.length < 3) return;
              unsubscribe();
              resolve();
            },
            error: reject,
            complete: resolve,
          },
        );
      });
      for (let waited = 0; subscriber.handlers.size === 0 && waited < 2000; waited += 10) {
        await pause(10);
      }
      subscriber.publish([{ currency: 'UAH', amount: '100', version: 1 }]);
      subscriber.publish([{ currency: 'UAH', amount: 'not-a-number', version: 2 }]);
      subscriber.publish([{ currency: 'UAH', amount: '300', version: 3 }]);
      await done;
    } finally {
      await client.dispose();
    }

    expect(results).toEqual([
      { data: { balanceChanged: [{ currency: 'UAH', amount: '100', version: 1 }] } },
      {
        data: null,
        errors: [
          {
            message: 'Internal server error',
            locations: [{ line: 1, column: 31 }],
            path: ['balanceChanged'],
            extensions: { code: 'INTERNAL_SERVER_ERROR' },
          },
        ],
      },
      { data: { balanceChanged: [{ currency: 'UAH', amount: '300', version: 3 }] } },
    ]);
    const logs = lines.slice(before);
    const problems = logs.filter((line) => line.level === 'warn' || line.level === 'error');
    expect(problems).toEqual([
      expect.objectContaining({
        level: 'error',
        context: 'GraphQL',
        operation: 'subscription BalanceChanged',
        subscriptionId: expect.any(String),
        code: 'INTERNAL_SERVER_ERROR',
        requestId,
        path: 'balanceChanged',
        err: expect.objectContaining({
          type: 'SyntaxError',
          stack: expect.stringContaining('BigInt'),
        }),
      }),
    ]);
    expect(nestErrors.slice(nestBefore)).toEqual([]);
    const counted = (await metrics.graphqlErrors.get()).values.filter(
      (v) =>
        v.labels.operation === 'subscription balanceChanged' &&
        v.labels.code === 'INTERNAL_SERVER_ERROR',
    );
    expect(counted.map((v) => v.value)).toEqual([1]);
    expect(errorsBefore).toBe(0);
  });
});
