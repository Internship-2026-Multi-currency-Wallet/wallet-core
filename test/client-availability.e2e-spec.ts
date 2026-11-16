import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { Controller, Get, type INestApplication, Module } from '@nestjs/common';
import { ApplicationConfig } from '@nestjs/core';
import {
  Field,
  Mutation,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  Resolver,
  Subscription,
} from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { createClient, type FormattedExecutionResult } from 'graphql-ws';
import { PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import request from 'supertest';
import WebSocket from 'ws';
import { AppModule } from '../src/app.module.js';
import type { AuthUser } from '../src/auth/auth-user.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { CurrentUser } from '../src/auth/current-user.decorator.js';
import { Public } from '../src/auth/public.decorator.js';
import { TokenService } from '../src/auth/tokens.js';
import { AppConfig } from '../src/config/app-config.js';
import type { ClientCode } from '../src/config/env.schema.js';
import { EventSubscriber } from '../src/events/event-bus.js';
import { httpLoggerOptions } from '../src/logging/logger.options.js';
import { loggerSettings } from '../src/logging/logging.module.js';
import { PermissionGuard } from '../src/permissions/permission.guard.js';
import { RequirePermission } from '../src/permissions/require-permission.decorator.js';
import {
  ClientDisabled,
  ClientFeature,
} from '../src/customizations/client-availability.decorator.js';
import { ClientAvailabilityGuard } from '../src/customizations/client-availability.guard.js';

/**
 * Does not exercise MySQL or Redis: Knex and Redis connect lazily and nothing here queries them,
 * and the Redis `EventSubscriber` (the only provider that connects at startup) is stubbed.
 * `NODE_ENV=production` keeps the committed `schema.graphql` from being rewritten.
 */

/* -------------------------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------------------------- */

const executed: string[] = [];

@ObjectType()
class ProbeAccount {
  @Field() id!: string;

  @ClientFeature('wisla')
  @Field(() => String, { nullable: true })
  wislaNote?: string | null;
}

@Resolver(() => ProbeAccount)
class ProbeAccountFields {
  @ClientDisabled('demo')
  @ResolveField(() => String, { nullable: true })
  notForDemo(@Parent() account: ProbeAccount): string {
    executed.push('notForDemo');
    return `not-for-demo:${account.id}`;
  }
}

async function* ticks(name: string): AsyncGenerator<Record<string, string>> {
  executed.push(name);
  yield await Promise.resolve({ [name]: `${name}:tick` });
}

@Resolver()
class ProbeOperations {
  @Public()
  @Query(() => ProbeAccount)
  probeAccount(): ProbeAccount {
    executed.push('probeAccount');
    return Object.assign(new ProbeAccount(), { id: 'p1', wislaNote: 'wisla-note' });
  }

  @ClientFeature('wisla')
  @Query(() => String)
  wislaOnlyProbe(@CurrentUser() user: AuthUser): string {
    executed.push('wislaOnlyProbe');
    return `wisla:${user.id}`;
  }

  @ClientDisabled('kvitka')
  @RequirePermission('bo:probe:modify')
  @Mutation(() => String)
  notForKvitkaProbe(): string {
    executed.push('notForKvitkaProbe');
    return 'mutated';
  }

  @ClientFeature('wisla')
  @Subscription(() => String)
  wislaTicks(): AsyncGenerator<Record<string, string>> {
    return ticks('wislaTicks');
  }

  @Public()
  @Subscription(() => String)
  probeTicks(): AsyncGenerator<Record<string, string>> {
    return ticks('probeTicks');
  }
}

@Controller('__probe')
class ProbeController {
  @Public()
  @Get('ping')
  ping(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController], providers: [ProbeOperations, ProbeAccountFields] })
class ProbeModule {}

/* -------------------------------------------------------------------------------------------- *
 * Harness
 * -------------------------------------------------------------------------------------------- */

/** A user id as the access token schema requires (a UUID). */
const USER_ID = '00000000-0000-4000-8000-000000000042';

/** Test-only value, at least 32 characters; production mode refuses the local placeholder. */
const TEST_JWT_SECRET = 'availability-spec-test-only-secret-0123456789';

/** nestjs-pino keeps one pino-http instance per process, so every app booted here shares this. */
const pinoLog: Record<string, unknown>[] = [];
const pinoStream = new Writable({
  write(chunk: Buffer, _encoding, done) {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      pinoLog.push(JSON.parse(line) as Record<string, unknown>);
    }
    done();
  },
});

interface Booted {
  app: INestApplication;
  wsUrl: string;
  /** What Nest's own logger was asked to log at warn level or above. */
  nestLog: string[];
}

async function boot(client: ClientCode): Promise<Booted> {
  const config = AppConfig.fromEnv({
    NODE_ENV: 'production',
    BACKOFFICE_URL: 'https://bo.example.com',
    APP_ENV: 'local',
    CLIENT: client,
    DEV_AUTH: 'true',
    JWT_SECRET: TEST_JWT_SECRET,
    LOG_LEVEL: 'warn',
    EMAIL_PREVIEW_ENABLED: 'true',
    // e2e apps share one Redis counter per IP: use the setup-env.ts limits, not the defaults.
    THROTTLE_LIMIT_ANONYMOUS: process.env.THROTTLE_LIMIT_ANONYMOUS,
    THROTTLE_LIMIT_USER: process.env.THROTTLE_LIMIT_USER,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, ProbeModule] })
    .overrideProvider(AppConfig)
    .useValue(config)
    .overrideProvider(EventSubscriber)
    .useValue({ subscribe: () => Promise.resolve(() => Promise.resolve()), close: () => undefined })
    .overrideProvider(PARAMS_PROVIDER_TOKEN)
    .useValue({ pinoHttp: [httpLoggerOptions(loggerSettings(config)), pinoStream] })
    .compile();
  const nestLog: string[] = [];
  const noop = (): void => undefined;
  const capture = (message: unknown): void => {
    nestLog.push(String(message));
  };
  const app = moduleRef.createNestApplication({
    logger: {
      log: noop,
      debug: noop,
      verbose: noop,
      warn: capture,
      error: capture,
      fatal: capture,
    },
  });
  try {
    await app.listen(0, '127.0.0.1');
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
  const { port } = (app.getHttpServer() as { address(): AddressInfo }).address();
  return { app, wsUrl: `ws://127.0.0.1:${port}/graphql`, nestLog };
}

interface GqlError {
  message: string;
  path?: (string | number)[];
  extensions?: Record<string, unknown>;
}

interface Body {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
}

async function gql(app: INestApplication, query: string, authorization?: string): Promise<Body> {
  const req = request(app.getHttpServer() as never).post('/graphql');
  if (authorization) req.set('Authorization', authorization);
  const response = await req.send({ query });
  return response.body as Body;
}

type WsResult = FormattedExecutionResult<Record<string, unknown>, unknown>;

async function ws(url: string, query: string, authorization?: string): Promise<WsResult[]> {
  const client = createClient({
    url,
    webSocketImpl: WebSocket,
    retryAttempts: 0,
    connectionParams: authorization ? { Authorization: authorization } : {},
  });
  try {
    return await new Promise<WsResult[]>((resolve, reject) => {
      const received: WsResult[] = [];
      client.subscribe(
        { query },
        {
          next: (value) => received.push(value),
          error: reject,
          complete: () => resolve(received),
        },
      );
    });
  } finally {
    await client.dispose();
  }
}

const NOT_FOUND = { message: 'Not Found', extensions: { code: 'NOT_FOUND' } };

/** Credentials a caller may send; a hidden endpoint must answer NOT_FOUND to every one of them. */
const ANY_CALLER: [string, string | undefined][] = [
  ['no credentials', undefined],
  ['an invalid JWT', 'Bearer not-a-jwt'],
  ['a JWT with an invalid signature', `Bearer ${invalidSignatureJwt()}`],
  ['malformed dev credentials', 'Dev bad id'],
  ['an authenticated user without permissions', 'Dev 7'],
];

/** A well-formed HS256 JWT whose signature is a literal placeholder, so verification must fail. */
function invalidSignatureJwt(): string {
  const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: '1', iss: 'wallet-core' })}.c2lnbmF0dXJl`;
}

const CLIENTS = ['demo', 'kvitka', 'wisla'] as const;

beforeEach(() => {
  executed.length = 0;
});

/* -------------------------------------------------------------------------------------------- *
 * Tests
 * -------------------------------------------------------------------------------------------- */

describe.each(CLIENTS)('client availability on the real AppModule, CLIENT=%s', (client) => {
  let booted: Booted;
  let app: INestApplication;
  const wislaOnlyDenied = client !== 'wisla';
  const notForKvitkaDenied = client === 'kvitka';

  beforeAll(async () => {
    booted = await boot(client);
    app = booted.app;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    pinoLog.length = 0;
    booted.nestLog.length = 0;
  });

  const jwt = (): string => {
    const subject = { userId: USER_ID, aud: 'wallet' as const, permissions: [] };
    return `Bearer ${app.get(TokenService).signAccessToken(subject, new Date()).token}`;
  };

  describe('global guards', () => {
    it('registers ClientAvailabilityGuard once, before AuthGuard and PermissionGuard', () => {
      const names = app
        .get(ApplicationConfig)
        .getGlobalGuards()
        .map((guard) => guard.constructor);
      expect(names.filter((guard) => guard === ClientAvailabilityGuard)).toHaveLength(1);
      const availability = names.indexOf(ClientAvailabilityGuard);
      const auth = names.indexOf(AuthGuard);
      const permission = names.indexOf(PermissionGuard);
      expect(availability).toBeGreaterThanOrEqual(0);
      expect(availability).toBeLessThan(auth);
      expect(auth).toBeLessThan(permission);
    });
  });

  describe('restricted root query (authenticated, wisla only)', () => {
    if (wislaOnlyDenied) {
      it.each(ANY_CALLER)('answers NOT_FOUND before authentication, with %s', async (_, auth) => {
        const body = await gql(app, '{ wislaOnlyProbe }', auth);
        expect(body.data).toBeNull();
        expect(body.errors).toHaveLength(1);
        expect(body.errors?.[0]).toMatchObject({ ...NOT_FOUND, path: ['wislaOnlyProbe'] });
        expect(executed).toEqual([]);
      });

      it('answers NOT_FOUND even to a valid JWT', async () => {
        const body = await gql(app, '{ wislaOnlyProbe }', jwt());
        expect(body.errors?.[0]).toMatchObject(NOT_FOUND);
        expect(executed).toEqual([]);
      });
    } else {
      it('keeps authentication: no credentials or an invalid JWT are UNAUTHENTICATED', async () => {
        for (const auth of [undefined, 'Bearer not-a-jwt', `Bearer ${invalidSignatureJwt()}`]) {
          const body = await gql(app, '{ wislaOnlyProbe }', auth);
          expect(body.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
        }
        expect(executed).toEqual([]);
      });

      it('runs the resolver for a valid JWT', async () => {
        expect(await gql(app, '{ wislaOnlyProbe }', jwt())).toEqual({
          data: { wislaOnlyProbe: `wisla:${USER_ID}` },
        });
      });
    }
  });

  describe('restricted root mutation (with @RequirePermission, not for kvitka)', () => {
    const MUTATION = 'mutation { notForKvitkaProbe }';
    if (notForKvitkaDenied) {
      it.each(ANY_CALLER)('answers NOT_FOUND before authentication, with %s', async (_, auth) => {
        const body = await gql(app, MUTATION, auth);
        expect(body.data).toBeNull();
        expect(body.errors?.[0]).toMatchObject({ ...NOT_FOUND, path: ['notForKvitkaProbe'] });
        expect(executed).toEqual([]);
      });

      it('answers NOT_FOUND even to a caller with the permission', async () => {
        const body = await gql(app, MUTATION, 'Dev 7:bo:probe:modify');
        expect(body.errors?.[0]).toMatchObject(NOT_FOUND);
        expect(executed).toEqual([]);
      });
    } else {
      it('keeps authentication and permissions: UNAUTHENTICATED, FORBIDDEN, then the result', async () => {
        const anonymous = await gql(app, MUTATION);
        expect(anonymous.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
        const invalid = await gql(app, MUTATION, 'Bearer not-a-jwt');
        expect(invalid.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
        const forbidden = await gql(app, MUTATION, 'Dev 7');
        expect(forbidden.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
        expect(executed).toEqual([]);
        expect(await gql(app, MUTATION, 'Dev 7:bo:probe:modify')).toEqual({
          data: { notForKvitkaProbe: 'mutated' },
        });
      });
    }
  });

  describe('restricted fields', () => {
    const deniedFields = [
      ...(wislaOnlyDenied ? ['wislaNote'] : []),
      ...(client === 'demo' ? ['notForDemo'] : []),
    ];

    it('answers a partial response: denied fields are null with NOT_FOUND at their path', async () => {
      const body = await gql(app, '{ probeAccount { id wislaNote notForDemo } }');
      expect(body.data).toEqual({
        probeAccount: {
          id: 'p1',
          wislaNote: deniedFields.includes('wislaNote') ? null : 'wisla-note',
          notForDemo: deniedFields.includes('notForDemo') ? null : 'not-for-demo:p1',
        },
      });
      const errors = body.errors ?? [];
      expect(errors.map((error) => error.path?.join('.')).sort()).toEqual(
        deniedFields.map((field) => `probeAccount.${field}`).sort(),
      );
      for (const error of errors) expect(error).toMatchObject(NOT_FOUND);
    });

    it('never runs the resolver of a denied @ResolveField', async () => {
      await gql(app, '{ probeAccount { notForDemo } }');
      expect(executed).toEqual(
        client === 'demo' ? ['probeAccount'] : ['probeAccount', 'notForDemo'],
      );
    });
  });

  describe('unrestricted endpoints', () => {
    it('GraphQL: me still requires authentication and answers a valid JWT', async () => {
      const anonymous = await gql(app, '{ me { id } }');
      expect(anonymous.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
      expect(await gql(app, '{ me { id strategy } }', jwt())).toEqual({
        data: { me: { id: USER_ID, strategy: 'jwt' } },
      });
    });

    it('HTTP: public controllers (probe, email preview) answer, and AuthGuard still protects the others', async () => {
      const server = app.getHttpServer() as never;
      await request(server).get('/__probe/ping').expect(200, { ok: true });
      await request(server).post('/diagnostics/ping').expect(401);
      await request(server).get('/dev/email-preview').expect(200);
    });
  });

  describe('logging and error formatting', () => {
    it('logs each denial once, as warn without a stack, and Nest does not log it again', async () => {
      await gql(app, '{ probeAccount { id wislaNote } }');
      await gql(app, '{ wislaOnlyProbe }', jwt());

      const graphqlLines = pinoLog.filter((line) => line.context === 'GraphQL');
      expect(graphqlLines.map((line) => [line.level, line.path])).toEqual(
        wislaOnlyDenied
          ? [
              ['warn', 'probeAccount.wislaNote'],
              ['warn', 'wislaOnlyProbe'],
            ]
          : [],
      );
      for (const line of graphqlLines) expect(line).not.toHaveProperty('err');
      expect(booted.nestLog).toEqual([]);
    });
  });

  describe('graphql-ws', () => {
    it('restricted root query over the websocket', async () => {
      const [result] = await ws(booted.wsUrl, '{ wislaOnlyProbe }');
      if (wislaOnlyDenied) {
        expect(result).toMatchObject({ data: null, errors: [NOT_FOUND] });
      } else {
        expect(result.errors?.[0]?.message).toBe('Authentication required');
        expect(await ws(booted.wsUrl, '{ wislaOnlyProbe }', jwt())).toEqual([
          { data: { wislaOnlyProbe: `wisla:${USER_ID}` } },
        ]);
      }
      expect(executed).toEqual(wislaOnlyDenied ? [] : ['wislaOnlyProbe']);
    });

    it('restricted field over the websocket: partial response with NOT_FOUND', async () => {
      const [result] = await ws(booted.wsUrl, '{ probeAccount { id wislaNote } }');
      if (wislaOnlyDenied) {
        expect(result).toMatchObject({
          data: { probeAccount: { id: 'p1', wislaNote: null } },
          errors: [{ ...NOT_FOUND, path: ['probeAccount', 'wislaNote'] }],
        });
      } else {
        expect(result).toEqual({ data: { probeAccount: { id: 'p1', wislaNote: 'wisla-note' } } });
      }
    });

    it('restricted subscription: NOT_FOUND before authentication, else the normal flow', async () => {
      const anonymous = await ws(booted.wsUrl, 'subscription { wislaTicks }');
      if (wislaOnlyDenied) {
        expect(anonymous).toHaveLength(1);
        expect(anonymous[0]).toMatchObject({ errors: [NOT_FOUND] });
        const withPermissions = await ws(booted.wsUrl, 'subscription { wislaTicks }', 'Dev 1');
        expect(withPermissions[0]).toMatchObject({ errors: [NOT_FOUND] });
        expect(executed).toEqual([]);
      } else {
        expect(anonymous[0]?.errors?.[0]?.message).toBe('Authentication required');
        expect(await ws(booted.wsUrl, 'subscription { wislaTicks }', 'Dev 1')).toEqual([
          { data: { wislaTicks: 'wislaTicks:tick' } },
        ]);
      }
    });

    it('formats a websocket denial without logging it per error, and Nest does not log it', async () => {
      await ws(booted.wsUrl, '{ probeAccount { id wislaNote } }');
      await ws(booted.wsUrl, 'subscription { wislaTicks }');
      expect(pinoLog.filter((line) => line.level === 'warn' || line.level === 'error')).toEqual([]);
      expect(booted.nestLog).toEqual([]);
    });

    it('an unrestricted public subscription is unaffected', async () => {
      expect(await ws(booted.wsUrl, 'subscription { probeTicks }')).toEqual([
        { data: { probeTicks: 'probeTicks:tick' } },
      ]);
    });
  });
});
