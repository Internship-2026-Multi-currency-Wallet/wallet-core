import {
  type CanActivate,
  Controller,
  Get,
  type INestApplication,
  Injectable,
  Module,
  type Provider,
  type Type,
} from '@nestjs/common';
import type { ApolloDriverConfig } from '@nestjs/apollo';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import {
  Args,
  Context,
  Extensions,
  Field,
  GraphQLModule,
  GraphQLSchemaHost,
  Info,
  InputType,
  InterfaceType,
  Mutation,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import {
  type GraphQLObjectType,
  type GraphQLResolveInfo,
  type GraphQLSchema,
  printSchema,
} from 'graphql';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { AppConfig } from '../config/app-config.js';
import type { ClientCode } from '../config/env.schema.js';
import { graphqlOptions } from '../graphql/graphql.config.js';
import {
  CLIENT_DISABLED_KEY,
  CLIENT_FEATURE_KEY,
  ClientDisabled,
  ClientFeature,
} from './client-availability.decorator.js';
import { ClientAvailabilityGuard } from './client-availability.guard.js';
import { ClientAvailabilityValidator } from './client-availability.validator.js';

/**
 * Field-level availability in a booted Nest + Apollo application, with the real decorators, the
 * real `graphqlOptions()` and the real `ClientAvailabilityGuard`, once per `CLIENT`.
 *
 * A small test module instead of `AppModule`, so the guard and the transform can be switched off
 * one at a time. The demo types are test fixtures; there is no demo behaviour in production code.
 *
 * Errors go through the real shared `formatError` (it comes with `graphqlOptions()`), so the wire
 * code is the final NOT_FOUND.
 */

/* -------------------------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------------------------- */

/** Which resolver bodies actually ran. */
const executed: string[] = [];

@ObjectType({ isAbstract: true })
abstract class InheritedFields {
  /** Restricted in a base class: a subtype inherits the restriction. */
  @ClientFeature('wisla')
  @Field(() => String, { nullable: true })
  inheritedNote?: string | null;
}

@ObjectType()
class Account extends InheritedFields {
  @Field() id!: string;

  /** Decorator written ABOVE @Field. */
  @ClientFeature('wisla')
  @Field(() => String, { nullable: true })
  wislaNote?: string | null;

  /** Decorator written BELOW @Field. */
  @Field(() => String, { nullable: true })
  @ClientDisabled('demo')
  notForDemo?: string | null;

  /** Next to an unrelated @Extensions entry, which has to survive. */
  @Extensions({ audit: 'kept' })
  @ClientFeature('wisla')
  @Field(() => String, { nullable: true })
  audited?: string | null;
}

@Resolver(() => Account)
class AccountFieldResolver {
  @ClientFeature('wisla')
  @ResolveField(() => String, { nullable: true })
  wislaBalance(
    @Parent() account: Account,
    @Args('currency') currency: string,
    @Context() context: { req?: { headers?: Record<string, string> } },
    @Info() info: GraphQLResolveInfo,
  ): string {
    executed.push('wislaBalance');
    return `${info.fieldName}:${account.id}:${currency}:${context.req?.headers?.['x-probe'] ?? '-'}`;
  }

  @ResolveField(() => String, { nullable: true })
  @ClientDisabled('kvitka')
  notForKvitka(@Parent() account: Account): string {
    executed.push('notForKvitka');
    return `not-for-kvitka:${account.id}`;
  }

  /** No restriction at all. */
  @ResolveField(() => String)
  plainResolved(@Parent() account: Account, @Args('suffix') suffix: string): string {
    executed.push('plainResolved');
    return `plain:${account.id}:${suffix}`;
  }
}

@Resolver()
class AccountQueries {
  @Query(() => Account)
  account(): Account {
    executed.push('account');
    return Object.assign(new Account(), {
      id: 'a1',
      wislaNote: 'wisla-note',
      notForDemo: 'not-for-demo',
      audited: 'audited',
      inheritedNote: 'inherited',
    });
  }

  /** A root endpoint: the guard enforces it, not the schema transform. */
  @ClientFeature('wisla')
  @Query(() => String)
  wislaOnlyQuery(): string {
    executed.push('wislaOnlyQuery');
    return 'wisla-only';
  }

  @ClientDisabled('demo')
  @Mutation(() => String)
  notForDemoMutation(): string {
    executed.push('notForDemoMutation');
    return 'mutated';
  }
}

/** An HTTP controller WITHOUT restrictions: the global guard has to let it through. */
@Controller('ping')
class PingController {
  @Get()
  ping(): { ok: true } {
    return { ok: true };
  }
}

/** Counts where a global guard runs (stands in for AuthGuard and PermissionGuard). */
@Injectable()
class CountingGuard implements CanActivate {
  static calls: string[] = [];

  canActivate(context: { getClass(): { name: string }; getHandler(): { name: string } }): boolean {
    CountingGuard.calls.push(`${context.getClass().name}.${context.getHandler().name}`);
    return true;
  }
}

const FIXTURES = [AccountFieldResolver, AccountQueries];

const ALL_FIELDS = `{ account { id wislaNote notForDemo audited inheritedNote
  wislaBalance(currency: "PLN") notForKvitka plainResolved(suffix: "z") } }`;

const VALUES: Record<string, string> = {
  id: 'a1',
  wislaNote: 'wisla-note',
  notForDemo: 'not-for-demo',
  audited: 'audited',
  inheritedNote: 'inherited',
  wislaBalance: 'wislaBalance:a1:PLN:p1',
  notForKvitka: 'not-for-kvitka:a1',
  plainResolved: 'plain:a1:z',
};

/** Fields each client must NOT get, and the resolver methods that may therefore run. */
const DENIED: Record<ClientCode, string[]> = {
  kvitka: ['wislaNote', 'audited', 'inheritedNote', 'wislaBalance', 'notForKvitka'],
  wisla: [],
  demo: ['wislaNote', 'audited', 'inheritedNote', 'wislaBalance', 'notForDemo'],
};

const CLIENTS = ['kvitka', 'wisla', 'demo'] as const;

/* -------------------------------------------------------------------------------------------- *
 * Harness
 * -------------------------------------------------------------------------------------------- */

interface BootOptions {
  client: ClientCode;
  /** Without the transform: the field restrictions are then not enforced. Default: with. */
  transform?: boolean;
  /** The global ClientAvailabilityGuard. Default: registered. */
  guard?: boolean;
  /** The startup validator. Default: registered. */
  validator?: boolean;
  /** Extra resolvers, controllers or providers of a test. */
  extra?: Provider[];
  controllers?: Type[];
}

interface Booted {
  app: INestApplication;
  schema: GraphQLSchema;
  /** What the real `graphqlLoggingPlugin` wrote to `req.log`. */
  pluginLog: { level: string; fields: Record<string, unknown> }[];
  /** What Nest's own logger was asked to log at warn level or above. */
  nestLog: { level: string; message: string }[];
}

async function boot(options: BootOptions): Promise<Booted> {
  const config = AppConfig.fromEnv({ NODE_ENV: 'test', CLIENT: options.client });
  const base = graphqlOptions(config, { setContext: () => undefined } as unknown as PinoLogger);

  @Module({
    imports: [
      DiscoveryModule,
      GraphQLModule.forRoot<ApolloDriverConfig>({
        ...base,
        autoSchemaFile: true,
        // Overrides the real transform that `graphqlOptions()` sets.
        ...(options.transform === false ? { transformSchema: undefined } : {}),
      }),
    ],
    controllers: [PingController, ...(options.controllers ?? [])],
    providers: [
      ...FIXTURES,
      ...(options.extra ?? []),
      { provide: AppConfig, useValue: config },
      { provide: PinoLogger, useValue: { setContext: () => undefined, error: () => undefined } },
      ...(options.validator === false ? [] : [ClientAvailabilityValidator]),
      ...(options.guard === false
        ? []
        : [{ provide: APP_GUARD, useClass: ClientAvailabilityGuard }]),
      { provide: APP_GUARD, useClass: CountingGuard },
    ],
  })
  class TestModule {}

  const pluginLog: Booted['pluginLog'] = [];
  const nestLog: Booted['nestLog'] = [];
  const noop = (): void => undefined;
  const capture =
    (level: string) =>
    (message: unknown): void => {
      nestLog.push({ level, message: String(message) });
    };
  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  const app = moduleRef.createNestApplication({
    logger: {
      log: noop,
      debug: noop,
      verbose: noop,
      warn: capture('warn'),
      error: capture('error'),
      fatal: capture('fatal'),
    },
  });
  // Gives the real graphqlLoggingPlugin a `req.log` to write to (pino-http does that in production).
  app.use((req: { log?: unknown }, _res: unknown, next: () => void) => {
    const write =
      (level: string) =>
      (fields: Record<string, unknown>): void => {
        pluginLog.push({ level, fields });
      };
    req.log = { warn: write('warn'), error: write('error') };
    next();
  });
  try {
    await app.init();
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
  return { app, schema: app.get(GraphQLSchemaHost).schema, pluginLog, nestLog };
}

interface Body {
  data?: Record<string, unknown> | null;
  errors?: { message: string; path?: (string | number)[]; extensions?: Record<string, unknown> }[];
}

async function gql(
  app: INestApplication,
  query: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Body }> {
  const response = await request(app.getHttpServer() as never)
    .post('/graphql')
    .set(headers)
    .send({ query });
  return { status: response.status, body: response.body as Body };
}

async function withApp<T>(options: BootOptions, run: (booted: Booted) => Promise<T>): Promise<T> {
  const booted = await boot(options);
  try {
    return await run(booted);
  } finally {
    await booted.app.close();
  }
}

const fieldsOf = (schema: GraphQLSchema, type: string) =>
  (schema.getType(type) as GraphQLObjectType).getFields();

beforeEach(() => {
  executed.length = 0;
  CountingGuard.calls = [];
});

/* -------------------------------------------------------------------------------------------- *
 * Tests
 * -------------------------------------------------------------------------------------------- */

describe.each(CLIENTS)('field availability, CLIENT=%s', (client) => {
  const denied = DENIED[client];

  it('denies exactly the restricted fields, @Field and @ResolveField alike, as a partial response', async () => {
    await withApp({ client }, async ({ app }) => {
      const { status, body } = await gql(app, ALL_FIELDS, { 'x-probe': 'p1' });

      expect(status).toBe(200);
      const expectedAccount = Object.fromEntries(
        Object.entries(VALUES).map(([name, value]) => [name, denied.includes(name) ? null : value]),
      );
      expect(body.data).toEqual({ account: expectedAccount });
      const paths = (body.errors ?? []).map((error) => error.path?.join('.')).sort();
      expect(paths).toEqual(denied.map((name) => `account.${name}`).sort());
    });
  });

  it('runs the resolver of an allowed field, and never the resolver of a denied one', async () => {
    await withApp({ client }, async ({ app }) => {
      await gql(app, ALL_FIELDS, { 'x-probe': 'p1' });
      const resolvers = ['wislaBalance', 'notForKvitka', 'plainResolved'];
      const expected = ['account', ...resolvers.filter((name) => !denied.includes(name))];
      expect([...executed].sort()).toEqual(expected.sort());
    });
  });

  it('answers a query of unrestricted fields without any error, and logs nothing', async () => {
    await withApp({ client }, async ({ app, pluginLog, nestLog }) => {
      const { body } = await gql(app, `{ account { id plainResolved(suffix: "q") } }`);
      expect(body).toEqual({ data: { account: { id: 'a1', plainResolved: 'plain:a1:q' } } });
      expect(pluginLog).toEqual([]);
      expect(nestLog).toEqual([]);
    });
  });

  it('runs a global guard once per operation, not per field', async () => {
    await withApp({ client }, async ({ app }) => {
      await gql(app, ALL_FIELDS, { 'x-probe': 'p1' });
      expect(CountingGuard.calls).toEqual(['AccountQueries.account']);
    });
  });

  // Same wire shape as a denied field, so a client cannot tell "not for you" from "does not exist".
  const DENIED_BY_GUARD = {
    message: 'Not Found',
    extensions: { code: 'NOT_FOUND', status: 404 },
  };

  it('keeps the root endpoints on the guard: a 404 from the guard, or the normal result', async () => {
    await withApp({ client }, async ({ app }) => {
      const query = await gql(app, `{ wislaOnlyQuery }`);
      const mutation = await gql(app, `mutation { notForDemoMutation }`);
      if (client === 'wisla') {
        expect(query.body).toEqual({ data: { wislaOnlyQuery: 'wisla-only' } });
      } else {
        expect(query.body.data).toBeNull();
        expect(query.body.errors?.[0]).toMatchObject(DENIED_BY_GUARD);
        expect(executed).not.toContain('wislaOnlyQuery');
      }
      if (client === 'demo') {
        expect(mutation.body.data).toBeNull();
        expect(mutation.body.errors?.[0]).toMatchObject(DENIED_BY_GUARD);
        expect(executed).not.toContain('notForDemoMutation');
      } else {
        expect(mutation.body).toEqual({ data: { notForDemoMutation: 'mutated' } });
      }
    });
  });

  it('lets an HTTP controller without restrictions through the global guard', async () => {
    await withApp({ client }, async ({ app }) => {
      const response = await request(app.getHttpServer() as never).get('/ping');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
    });
  });
});

describe('an allowed restricted field', () => {
  it('runs its resolver with the parent, arguments, context and info (CLIENT=wisla)', async () => {
    await withApp({ client: 'wisla' }, async ({ app }) => {
      const { body } = await gql(app, `{ account { wislaBalance(currency: "EUR") } }`, {
        'x-probe': 'from-context',
      });
      expect(body).toEqual({
        data: { account: { wislaBalance: 'wislaBalance:a1:EUR:from-context' } },
      });
    });
  });
});

describe('schema', () => {
  it('keeps the @Extensions on @Field and @ResolveField fields, in either decorator order', async () => {
    await withApp({ client: 'kvitka' }, ({ schema }) => {
      const account = fieldsOf(schema, 'Account');
      expect(account.wislaNote?.extensions[CLIENT_FEATURE_KEY]).toEqual(['wisla']); // above @Field
      expect(account.notForDemo?.extensions[CLIENT_DISABLED_KEY]).toEqual(['demo']); // below @Field
      expect(account.wislaBalance?.extensions[CLIENT_FEATURE_KEY]).toEqual(['wisla']); // above
      expect(account.notForKvitka?.extensions[CLIENT_DISABLED_KEY]).toEqual(['kvitka']); // below
      expect(account.id?.extensions[CLIENT_FEATURE_KEY]).toBeUndefined();
      expect(account.plainResolved?.extensions[CLIENT_FEATURE_KEY]).toBeUndefined();
      return Promise.resolve();
    });
  });

  it('keeps an unrelated @Extensions entry next to ours', async () => {
    await withApp({ client: 'kvitka' }, ({ schema }) => {
      const audited = fieldsOf(schema, 'Account').audited?.extensions;
      expect(audited?.audit).toBe('kept');
      expect(audited?.[CLIENT_FEATURE_KEY]).toEqual(['wisla']);
      return Promise.resolve();
    });
  });

  it('passes a restriction on a field of an abstract base type on to the subtype', async () => {
    await withApp({ client: 'kvitka' }, async ({ schema, app }) => {
      expect(fieldsOf(schema, 'Account').inheritedNote?.extensions[CLIENT_FEATURE_KEY]).toEqual([
        'wisla',
      ]);
      const { body } = await gql(app, `{ account { inheritedNote } }`);
      expect(body.errors?.[0]?.path).toEqual(['account', 'inheritedNote']);
    });
  });

  it('is one shared schema: the printed schema is the same for every client, with or without the transform', async () => {
    const printed: string[] = [];
    for (const client of CLIENTS) {
      printed.push(await withApp({ client }, ({ schema }) => Promise.resolve(printSchema(schema))));
    }
    printed.push(
      await withApp({ client: 'kvitka', transform: false }, ({ schema }) =>
        Promise.resolve(printSchema(schema)),
      ),
    );
    expect(new Set(printed).size).toBe(1);
    expect(printed[0]).toContain('wislaNote: String');
    expect(printed[0]).toContain('wislaBalance(currency: String!): String');
    expect(printed[0]).toContain('wislaOnlyQuery: String!');
  });

  it('shows the hidden fields to introspection (a runtime restriction, not a different schema)', async () => {
    await withApp({ client: 'kvitka' }, async ({ app }) => {
      const { body } = await gql(app, `{ __type(name: "Account") { fields { name } } }`);
      const names = (body.data as { __type: { fields: { name: string }[] } }).__type.fields.map(
        (entry) => entry.name,
      );
      expect(names).toEqual(expect.arrayContaining(['wislaNote', 'wislaBalance', 'notForKvitka']));
    });
  });
});

describe('what the transform does not do', () => {
  it('does not enforce root endpoints: without the guard, a restricted Query still answers', async () => {
    await withApp({ client: 'kvitka', guard: false }, async ({ app }) => {
      const { body } = await gql(app, `{ wislaOnlyQuery }`);
      expect(body).toEqual({ data: { wislaOnlyQuery: 'wisla-only' } });
    });
  });

  it('does not enforce a field restriction when it is left out of the configuration', async () => {
    await withApp({ client: 'kvitka', transform: false }, async ({ app }) => {
      const { body } = await gql(app, `{ account { wislaNote } }`);
      expect(body).toEqual({ data: { account: { wislaNote: 'wisla-note' } } });
    });
  });
});

describe('error contract of a denied field', () => {
  it('answers extensions.code NOT_FOUND through the shared formatError, as a partial response', async () => {
    await withApp({ client: 'kvitka' }, async ({ app }) => {
      const { status, body } = await gql(app, `{ account { id wislaNote } }`);
      expect(status).toBe(200);
      expect(body.data).toEqual({ account: { id: 'a1', wislaNote: null } });
      expect(body.errors).toHaveLength(1);
      expect(body.errors?.[0]).toMatchObject({
        message: 'Not Found',
        path: ['account', 'wislaNote'],
        extensions: { code: 'NOT_FOUND', status: 404 },
      });
    });
  });

  it('is logged once per denied field as a warning (the shared plugin treats 4xx as a client error), and Nest does not log it again', async () => {
    await withApp({ client: 'kvitka' }, async ({ app, pluginLog, nestLog }) => {
      await gql(app, `{ account { id wislaNote wislaBalance(currency: "x") } }`);
      expect(
        pluginLog.map(({ level, fields }) => ({ level, code: fields.code, path: fields.path })),
      ).toEqual([
        { level: 'warn', code: 'HTTP_404', path: 'account.wislaNote' },
        { level: 'warn', code: 'HTTP_404', path: 'account.wislaBalance' },
      ]);
      expect(nestLog).toEqual([]);
    });
  });
});

describe('startup validation', () => {
  it('keeps the restriction of a field resolver that a derived resolver overrides under the SAME name (and would refuse to start if Nest stopped doing so)', async () => {
    @ObjectType()
    class OverrideProbe {
      @Field() id!: string;
    }
    @Resolver(() => OverrideProbe, { isAbstract: true })
    abstract class RestrictedFieldBase {
      @ClientFeature('wisla')
      @ResolveField(() => String, { nullable: true })
      secret(): string {
        return 'wisla-data';
      }
    }
    @Resolver(() => OverrideProbe)
    class PlainOverride extends RestrictedFieldBase {
      @ResolveField(() => String, { nullable: true })
      override secret(): string {
        return 'wisla-data';
      }
    }
    @Resolver()
    class OverrideQueries {
      @Query(() => OverrideProbe)
      overrideProbe(): OverrideProbe {
        return { id: 'probe' };
      }
    }
    await withApp(
      { client: 'kvitka', extra: [PlainOverride, OverrideQueries] },
      async ({ app }) => {
        const { body } = await gql(app, `{ overrideProbe { secret } }`);
        expect(body.data).toEqual({ overrideProbe: { secret: null } });
        expect(body.errors?.[0]?.path).toEqual(['overrideProbe', 'secret']);
      },
    );
    await withApp({ client: 'wisla', extra: [PlainOverride, OverrideQueries] }, async ({ app }) => {
      const { body } = await gql(app, `{ overrideProbe { secret } }`);
      expect(body).toEqual({ data: { overrideProbe: { secret: 'wisla-data' } } });
    });
  });

  it('rejects a restricted ancestor field resolver redeclared under another schema name', async () => {
    @ObjectType()
    class ResolverAliasProbe {
      @Field() id!: string;
    }
    @Resolver(() => ResolverAliasProbe, { isAbstract: true })
    abstract class RestrictedResolverBase {
      @ClientFeature('wisla')
      @ResolveField(() => String, { nullable: true })
      secret(): string {
        return 'LEAK';
      }
    }
    @Resolver(() => ResolverAliasProbe)
    class RenamedResolver extends RestrictedResolverBase {
      @ResolveField('exposed', () => String, { nullable: true })
      override secret(): string {
        return 'LEAK';
      }
    }
    @Resolver()
    class ResolverAliasQueries {
      @Query(() => ResolverAliasProbe)
      resolverAliasProbe(): ResolverAliasProbe {
        return { id: 'probe' };
      }
    }
    await expect(
      boot({ client: 'kvitka', extra: [RenamedResolver, ResolverAliasQueries] }),
    ).rejects.toThrow(/RestrictedResolverBase.secret: .*restriction did not reach/);
  });

  @ObjectType()
  class RequiredField {
    @Field() id!: string;

    @ClientFeature('wisla')
    @Field(() => String)
    required!: string;
  }

  @Resolver()
  class RequiredFieldQueries {
    @Query(() => RequiredField)
    requiredField(): RequiredField {
      return Object.assign(new RequiredField(), { id: 'r', required: 'r' });
    }
  }

  @ObjectType()
  class RequiredResolved {
    @Field() id!: string;
  }

  @Resolver(() => RequiredResolved)
  class RequiredResolvedFields {
    @ClientDisabled('demo')
    @ResolveField(() => String)
    required(): string {
      return 'r';
    }

    @Query(() => RequiredResolved)
    requiredResolved(): RequiredResolved {
      return Object.assign(new RequiredResolved(), { id: 'r' });
    }
  }

  @ClientFeature('wisla')
  @ObjectType()
  class RestrictedTypeClass {
    @Field() id!: string;
  }

  @Resolver()
  class RestrictedTypeQueries {
    @Query(() => RestrictedTypeClass)
    restrictedType(): RestrictedTypeClass {
      return Object.assign(new RestrictedTypeClass(), { id: 'r' });
    }
  }

  /** A field declared BOTH with @Field on the type and with @ResolveField on a resolver. */
  @ObjectType()
  class DoubleDeclared {
    @Field() id!: string;

    @Field(() => String, { nullable: true })
    both?: string | null;

    @ClientFeature('wisla')
    @Field(() => String, { nullable: true })
    bothRightPlace?: string | null;
  }

  @Resolver(() => DoubleDeclared)
  class DoubleDeclaredFields {
    /** Wrong place: Nest drops this extension because the type declares the field too. */
    @ClientFeature('wisla')
    @ResolveField(() => String, { nullable: true })
    both(): string {
      return 'resolved';
    }

    @Query(() => DoubleDeclared)
    doubleDeclared(): DoubleDeclared {
      return Object.assign(new DoubleDeclared(), { id: 'd' });
    }
  }

  @Resolver(() => DoubleDeclared)
  class DoubleDeclaredRightPlace {
    /** The restriction is on the type's @Field (above); the resolver needs no decorator. */
    @ResolveField(() => String, { nullable: true })
    bothRightPlace(): string {
      executed.push('bothRightPlace');
      return 'resolved';
    }

    @Query(() => DoubleDeclared)
    doubleDeclaredRight(): DoubleDeclared {
      return Object.assign(new DoubleDeclared(), { id: 'd' });
    }
  }

  /** Narrowing in a subclass is safe and accepted; widening is not. */
  @ObjectType({ isAbstract: true })
  abstract class TwoClientsBase {
    @ClientFeature('wisla', 'kvitka')
    @Field(() => String, { nullable: true })
    shared?: string | null = null;
  }

  @ObjectType()
  class NarrowerSubclass extends TwoClientsBase {
    @ClientFeature('wisla')
    @Field(() => String, { nullable: true })
    override shared?: string | null = 'ok';
  }

  @Resolver()
  class NarrowerQueries {
    @Query(() => NarrowerSubclass)
    narrower(): NarrowerSubclass {
      return new NarrowerSubclass();
    }
  }

  /** Two properties whose schema names cross over: neither is a redeclaration of the other. */
  @ObjectType()
  class AliasSwap {
    @ClientFeature('wisla')
    @Field(() => String, { nullable: true, name: 'publicName' })
    internal?: string | null = 'restricted';

    @Field(() => String, { nullable: true, name: 'internal' })
    unrelated?: string | null = 'open';
  }

  @Resolver()
  class AliasSwapQueries {
    @Query(() => AliasSwap)
    aliasSwap(): AliasSwap {
      return new AliasSwap();
    }
  }

  /** Input types support no restriction; a redeclaration must not hide that. */
  @InputType({ isAbstract: true })
  abstract class RestrictedInputBase {
    @ClientFeature('wisla')
    @Field(() => String, { nullable: true })
    secret?: string | null;
  }

  @InputType()
  class RedeclaredInput extends RestrictedInputBase {
    @Field(() => String, { nullable: true })
    override secret?: string | null = null;
  }

  @Resolver()
  class RedeclaredInputQueries {
    @Query(() => String, { nullable: true })
    echoInput(@Args('input', { nullable: true }) input?: RedeclaredInput): string | null {
      return input?.secret ?? null;
    }
  }

  /**
   * The same, with a `@Field({ name })`: the schema name differs from the property name, so the
   * restricted property and the schema field must be matched through Nest's metadata.
   */
  @ObjectType({ isAbstract: true })
  abstract class NamedBase {
    @ClientFeature('wisla')
    @Field(() => String, { nullable: true, name: 'aliased' })
    secret?: string | null = null;
  }

  @ObjectType()
  class NamedSameName extends NamedBase {
    @Field(() => String, { nullable: true, name: 'aliased' })
    override secret?: string | null = null;
  }

  @ObjectType()
  class NamedRenamed extends NamedBase {
    @Field(() => String, { nullable: true, name: 'exposed' })
    override secret?: string | null = null;
  }

  @ObjectType()
  class NamedTakenOver extends NamedBase {
    @Field(() => String, { nullable: true, name: 'aliased' })
    other?: string | null = null;
  }

  @ObjectType()
  class NamedRepeats extends NamedBase {
    @ClientFeature('wisla')
    @Field(() => String, { nullable: true, name: 'aliased' })
    override secret?: string | null = 'ok';
  }

  @ObjectType()
  class NamedDirect {
    @ClientFeature('wisla')
    @Field(() => String, { nullable: true, name: 'aliased' })
    secret?: string | null = 'ok';
  }

  @Resolver()
  class NamedSameNameQueries {
    @Query(() => NamedSameName)
    namedSameName(): NamedSameName {
      return Object.assign(new NamedSameName(), { secret: 'LEAK' });
    }
  }

  @Resolver()
  class NamedRenamedQueries {
    @Query(() => NamedRenamed)
    namedRenamed(): NamedRenamed {
      return Object.assign(new NamedRenamed(), { secret: 'LEAK' });
    }
  }

  @Resolver()
  class NamedTakenOverQueries {
    @Query(() => NamedTakenOver)
    namedTakenOver(): NamedTakenOver {
      return Object.assign(new NamedTakenOver(), { other: 'LEAK' });
    }
  }

  @Resolver()
  class NamedRepeatsQueries {
    @Query(() => NamedRepeats)
    namedRepeats(): NamedRepeats {
      return new NamedRepeats();
    }
  }

  @Resolver()
  class NamedDirectQueries {
    @Query(() => NamedDirect)
    namedDirect(): NamedDirect {
      return new NamedDirect();
    }
  }

  /** A restricted field on an abstract base type, and subclasses that declare it again. */
  @ObjectType({ isAbstract: true })
  abstract class SecretBase {
    @ClientFeature('wisla')
    @Field(() => String, { nullable: true })
    secret?: string | null;
  }

  @ObjectType()
  class DropsRestriction extends SecretBase {
    @Field(() => String, { nullable: true })
    override secret?: string | null = null;
  }

  @ObjectType()
  class RepeatsRestriction extends SecretBase {
    @ClientFeature('wisla')
    @Field(() => String, { nullable: true })
    override secret?: string | null = null;
  }

  @ObjectType()
  class ChangesRestriction extends SecretBase {
    @ClientFeature('wisla', 'kvitka')
    @Field(() => String, { nullable: true })
    override secret?: string | null = null;
  }

  @Resolver()
  class RedeclarationQueries {
    @Query(() => DropsRestriction)
    dropsRestriction(): DropsRestriction {
      return Object.assign(new DropsRestriction(), { secret: 'LEAK' });
    }
  }

  @Resolver()
  class RepeatedQueries {
    @Query(() => RepeatsRestriction)
    repeatsRestriction(): RepeatsRestriction {
      return Object.assign(new RepeatsRestriction(), { secret: 'ok' });
    }
  }

  @Resolver()
  class ChangedQueries {
    @Query(() => ChangesRestriction)
    changesRestriction(): ChangesRestriction {
      return Object.assign(new ChangesRestriction(), { secret: 'x' });
    }
  }

  @InterfaceType()
  abstract class RestrictedInterface {
    @ClientFeature('wisla')
    @Field(() => String, { nullable: true })
    shared?: string | null;
  }

  @ObjectType({ implements: () => [RestrictedInterface] })
  class ImplementsRestricted extends RestrictedInterface {
    @Field() id!: string;
  }

  @InputType()
  class RestrictedInput {
    @ClientFeature('wisla')
    @Field(() => String, { nullable: true })
    by?: string | null;
  }

  @Resolver()
  class InterfaceAndInputQueries {
    @Query(() => ImplementsRestricted)
    implementsRestricted(
      @Args('filter', { nullable: true }) _filter?: RestrictedInput,
    ): ImplementsRestricted {
      return Object.assign(new ImplementsRestricted(), { id: 'i' });
    }
  }

  it('refuses to start when a @ResolveField restriction would be dropped by Nest (the type declares the field too)', async () => {
    await expect(boot({ client: 'kvitka', extra: [DoubleDeclaredFields] })).rejects.toThrow(
      /DoubleDeclaredFields\.both: the restriction did not reach the schema field/,
    );
  });

  it("enforces the restriction when it is on the type's @Field, even if a resolver also declares the field", async () => {
    await withApp({ client: 'kvitka', extra: [DoubleDeclaredRightPlace] }, async ({ app }) => {
      const { body } = await gql(app, `{ doubleDeclaredRight { id bothRightPlace } }`);
      expect(body.data).toEqual({ doubleDeclaredRight: { id: 'd', bothRightPlace: null } });
      expect(body.errors?.[0]?.path).toEqual(['doubleDeclaredRight', 'bothRightPlace']);
      expect(executed).not.toContain('bothRightPlace');
    });
    await withApp({ client: 'wisla', extra: [DoubleDeclaredRightPlace] }, async ({ app }) => {
      const { body } = await gql(app, `{ doubleDeclaredRight { bothRightPlace } }`);
      expect(body).toEqual({ data: { doubleDeclaredRight: { bothRightPlace: 'resolved' } } });
    });
  });

  it('refuses to start when a subclass declares an inherited restricted field again WITHOUT the restriction (Nest replaces the field and its extensions)', async () => {
    await expect(boot({ client: 'kvitka', extra: [RedeclarationQueries] })).rejects.toThrow(
      /DropsRestriction\.secret: .*restriction .*(lost|widened)/,
    );
  });

  it('refuses to start when a subclass declares it again with a DIFFERENT list (two lists cannot be intersected on one field)', async () => {
    await expect(boot({ client: 'kvitka', extra: [ChangedQueries] })).rejects.toThrow(
      /ChangesRestriction\.secret: .*restriction .*(lost|widened)/,
    );
  });

  it('accepts a subclass that repeats the same restriction, and enforces it', async () => {
    await withApp({ client: 'kvitka', extra: [RepeatedQueries] }, async ({ app }) => {
      const { body } = await gql(app, `{ repeatsRestriction { secret } }`);
      expect(body.data).toEqual({ repeatsRestriction: { secret: null } });
      expect(body.errors?.[0]?.path).toEqual(['repeatsRestriction', 'secret']);
    });
    await withApp({ client: 'wisla', extra: [RepeatedQueries] }, async ({ app }) => {
      const { body } = await gql(app, `{ repeatsRestriction { secret } }`);
      expect(body).toEqual({ data: { repeatsRestriction: { secret: 'ok' } } });
    });
  });

  /** The same clients listed in a different order are the same restriction. */
  @ObjectType({ isAbstract: true })
  abstract class OrderBase {
    @ClientFeature('wisla', 'kvitka')
    @Field(() => String, { nullable: true })
    allowed?: string | null = null;

    @ClientDisabled('demo', 'kvitka')
    @Field(() => String, { nullable: true })
    denied?: string | null = null;
  }

  @ObjectType()
  class OrderReversed extends OrderBase {
    @ClientFeature('kvitka', 'wisla')
    @Field(() => String, { nullable: true })
    override allowed?: string | null = 'allowed';

    @ClientDisabled('kvitka', 'demo')
    @Field(() => String, { nullable: true })
    override denied?: string | null = 'denied';
  }

  @ObjectType()
  class OrderDoubleDeclared {
    @ClientFeature('wisla', 'kvitka')
    @Field(() => String, { nullable: true })
    both?: string | null = 'both';
  }

  @Resolver(() => OrderDoubleDeclared)
  class OrderDoubleDeclaredFields {
    @ClientFeature('kvitka', 'wisla')
    @ResolveField(() => String, { nullable: true })
    both(): string {
      return 'resolved';
    }

    @Query(() => OrderDoubleDeclared)
    orderDoubleDeclared(): OrderDoubleDeclared {
      return new OrderDoubleDeclared();
    }
  }

  @Resolver()
  class OrderQueries {
    @Query(() => OrderReversed)
    orderReversed(): OrderReversed {
      return new OrderReversed();
    }
  }

  describe('the order of the clients in a list does not matter', () => {
    it.each(CLIENTS)(
      'accepts reordered lists on a redeclared field, and enforces them (CLIENT=%s)',
      async (client) => {
        await withApp(
          { client, extra: [OrderQueries, OrderDoubleDeclaredFields] },
          async ({ app }) => {
            const { body } = await gql(
              app,
              `{ orderReversed { allowed denied } orderDoubleDeclared { both } }`,
            );
            expect(body.data).toEqual({
              orderReversed: {
                allowed: client === 'demo' ? null : 'allowed',
                denied: client === 'wisla' ? 'denied' : null,
              },
              orderDoubleDeclared: { both: client === 'demo' ? null : 'resolved' },
            });
          },
        );
      },
    );
  });

  describe('what is accepted next to an inherited restriction', () => {
    it('lets a subclass NARROW the restriction, and enforces the narrower one', async () => {
      await withApp({ client: 'kvitka', extra: [NarrowerQueries] }, async ({ app }) => {
        const { body } = await gql(app, `{ narrower { shared } }`);
        expect(body.data).toEqual({ narrower: { shared: null } });
        expect(body.errors?.[0]?.path).toEqual(['narrower', 'shared']);
      });
      await withApp({ client: 'wisla', extra: [NarrowerQueries] }, async ({ app }) => {
        const { body } = await gql(app, `{ narrower { shared } }`);
        expect(body).toEqual({ data: { narrower: { shared: 'ok' } } });
      });
    });

    it('does not confuse a property with an unrelated one whose schema name equals its name', async () => {
      await withApp({ client: 'kvitka', extra: [AliasSwapQueries] }, async ({ app }) => {
        const { body } = await gql(app, `{ aliasSwap { publicName internal } }`);
        expect(body.data).toEqual({ aliasSwap: { publicName: null, internal: 'open' } });
        expect(body.errors?.map((error) => error.path)).toEqual([['aliasSwap', 'publicName']]);
      });
    });
  });

  it('refuses to start when a subclass redeclares a restricted INPUT field (no restriction is supported there)', async () => {
    await expect(boot({ client: 'kvitka', extra: [RedeclaredInputQueries] })).rejects.toThrow(
      /RedeclaredInput\.secret: a restriction on a field of an input type is not supported/,
    );
  });

  describe('a @Field({ name }) next to an inherited restriction', () => {
    it('enforces a restriction on a renamed field (control)', async () => {
      await withApp({ client: 'kvitka', extra: [NamedDirectQueries] }, async ({ app }) => {
        const { body } = await gql(app, `{ namedDirect { aliased } }`);
        expect(body.data).toEqual({ namedDirect: { aliased: null } });
        expect(body.errors?.[0]?.path).toEqual(['namedDirect', 'aliased']);
      });
    });

    it('accepts a subclass that repeats the same restriction on the renamed field, and enforces it', async () => {
      await withApp({ client: 'kvitka', extra: [NamedRepeatsQueries] }, async ({ app }) => {
        const { body } = await gql(app, `{ namedRepeats { aliased } }`);
        expect(body.data).toEqual({ namedRepeats: { aliased: null } });
        expect(body.errors?.[0]?.path).toEqual(['namedRepeats', 'aliased']);
      });
      await withApp({ client: 'wisla', extra: [NamedRepeatsQueries] }, async ({ app }) => {
        const { body } = await gql(app, `{ namedRepeats { aliased } }`);
        expect(body).toEqual({ data: { namedRepeats: { aliased: 'ok' } } });
      });
    });

    it.each([
      ['declared again under the same schema name', 'NamedSameName', NamedSameNameQueries],
      [
        'declared again under another schema name (an alias of the same data)',
        'NamedRenamed',
        NamedRenamedQueries,
      ],
      [
        "another property that takes the restricted field's schema name",
        'NamedTakenOver',
        NamedTakenOverQueries,
      ],
    ])(
      'refuses to start when a subclass has it %s, without the restriction',
      async (_case, type, queries) => {
        await expect(boot({ client: 'kvitka', extra: [queries] })).rejects.toThrow(
          new RegExp(`${type}\\.\\w+: the restriction declared on NamedBase is lost or widened`),
        );
      },
    );
  });

  it('inspects a resolver registered as a VALUE provider too (Nest finds resolvers by their instance)', async () => {
    const instance = new DoubleDeclaredFields();
    await expect(
      boot({ client: 'kvitka', extra: [{ provide: DoubleDeclaredFields, useValue: instance }] }),
    ).rejects.toThrow(/DoubleDeclaredFields\.both: the restriction did not reach the schema field/);
  });

  it.each(CLIENTS)(
    'refuses to start with a restricted NON-NULL @Field, even for CLIENT=%s that may use it',
    async (client) => {
      await expect(boot({ client, extra: [RequiredFieldQueries] })).rejects.toThrow(
        /RequiredField\.required: a restricted field must be nullable/,
      );
    },
  );

  it('refuses to start with a restricted non-null @ResolveField', async () => {
    await expect(boot({ client: 'kvitka', extra: [RequiredResolvedFields] })).rejects.toThrow(
      /RequiredResolved\.required: a restricted field must be nullable/,
    );
  });

  it('refuses to start with a restriction on the class of a GraphQL type', async () => {
    await expect(boot({ client: 'kvitka', extra: [RestrictedTypeQueries] })).rejects.toThrow(
      /RestrictedTypeClass: a restriction on a GraphQL type class is not supported/,
    );
  });

  it('refuses to start with a restriction on an interface or an input type field', async () => {
    await expect(boot({ client: 'kvitka', extra: [InterfaceAndInputQueries] })).rejects.toThrow(
      /(interface|input type)/,
    );
  });

  it('starts when the validator is not registered (the schema check alone still runs)', async () => {
    await withApp(
      { client: 'kvitka', extra: [RestrictedTypeQueries], validator: false },
      ({ schema }) => {
        expect(schema.getType('RestrictedTypeClass')).toBeDefined();
        return Promise.resolve();
      },
    );
  });
});
