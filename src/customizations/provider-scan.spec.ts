import { Controller, Get, Inject, Injectable, Module, Scope } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule, Int, Query, Resolver } from '@nestjs/graphql';
import request from 'supertest';
import 'reflect-metadata';
import { CLIENT_HOOK_KEY, ClientHook } from './client-hook.decorator.js';
import { Customizable } from './customizable.decorator.js';
import { HookRegistry } from './hook-registry.js';
import { wrapMethod } from './method-wrapper.js';
import {
  findTargetInstances,
  type ProviderLike,
  type ScanProblem,
  scanHookMethods,
} from './provider-scan.js';
import type { AfterHook } from './hook.types.js';

/** Everything the fixtures run, in order. A scan must never add to it. */
const calls: string[] = [];
beforeEach(() => {
  calls.length = 0;
});

/** Test fixtures; nothing to do with a real service. */
class Service {
  readonly ready = true;

  @Customizable()
  run(): Promise<number> {
    calls.push('core:run');
    return Promise.resolve(1);
  }
}

class OtherService {
  @Customizable()
  run(): Promise<number> {
    return Promise.resolve(2);
  }
}

class SubService extends Service {}

class BaseHooks {
  @ClientHook('kvitka', Service, 'run', 'after')
  inherited(_hook: AfterHook<Service, 'run'>): void {
    calls.push('hook:inherited');
  }

  @ClientHook('kvitka', Service, 'run', 'after')
  overridden(_hook: AfterHook<Service, 'run'>): void {
    calls.push('hook:overridden');
  }
}

class HidingHooks extends BaseHooks {
  // Not decorated again: the instance runs THIS one, which is no hook.
  override overridden(): void {
    calls.push('plain override');
  }
}

class RedecoratedHooks extends BaseHooks {
  @ClientHook('wisla', Service, 'run', 'before')
  override overridden(): void {
    calls.push('hook:redecorated');
  }
}

class Hooks {
  @ClientHook('kvitka', Service, 'run', 'after')
  @ClientHook('wisla', Service, 'run', 'after')
  stacked(_hook: AfterHook<Service, 'run'>): void {
    calls.push('hook:stacked');
  }

  @ClientHook('wisla', OtherService, 'run', 'after')
  second(_hook: AfterHook<OtherService, 'run'>): void {
    calls.push('hook:second');
  }

  notAHook(): void {
    calls.push('not a hook');
  }
}

function provider(
  instance: unknown,
  scope: { transient?: boolean; staticTree?: boolean } = {},
): ProviderLike {
  return {
    instance,
    isTransient: scope.transient ?? false,
    isDependencyTreeStatic: () => scope.staticTree ?? true,
  };
}

const codes = (problems: readonly ScanProblem[]): string[] => problems.map((p) => p.code);

describe('scanHookMethods', () => {
  it('finds decorated methods, with the method function, the instance and a copy of the entries', () => {
    const hooks = new Hooks();
    const { found, problems } = scanHookMethods([provider(hooks)]);

    expect(problems).toEqual([]);
    expect(found.map((m) => m.name)).toEqual(['stacked', 'second']);
    const [stacked, second] = found;
    expect(stacked.instance).toBe(hooks);
    expect(stacked.handler).toBe(Hooks.prototype.stacked); // the function, not a bound copy
    expect(stacked.entries).toEqual([
      expect.objectContaining({ client: 'wisla', phase: 'after' }), // the decorator nearest the method first
      expect.objectContaining({ client: 'kvitka', phase: 'after' }),
    ]);
    expect(second.entries).toHaveLength(1);
  });

  it('hands out a private copy of the entries', () => {
    const { found } = scanHookMethods([provider(new Hooks())]);
    const stored = Reflect.getOwnMetadata(CLIENT_HOOK_KEY, Hooks.prototype.stacked) as unknown[];
    expect(found[0].entries).not.toBe(stored);
    stored.push('later change');
    expect(found[0].entries).toHaveLength(2);
    stored.pop();
  });

  it('runs nothing: no hook, no core method, no ordinary method', () => {
    scanHookMethods([provider(new Hooks()), provider(new Service()), provider(new HidingHooks())]);
    expect(calls).toEqual([]);
  });

  it('reads its providers in order, and the members of each in definition order', () => {
    const first = new Hooks();
    const second = new RedecoratedHooks();
    const { found } = scanHookMethods([provider(first), provider(second)]);
    expect(found.map((m) => [m.instance, m.name])).toEqual([
      [first, 'stacked'],
      [first, 'second'],
      [second, 'overridden'],
      [second, 'inherited'],
    ]);
  });

  describe('inheritance: the member the instance would really run', () => {
    it('finds a decorated method that is inherited unchanged', () => {
      const { found } = scanHookMethods([provider(new BaseHooks())]);
      expect(found.map((m) => m.name)).toEqual(['inherited', 'overridden']);
      const derived = scanHookMethods([provider(new (class extends BaseHooks {})())]).found;
      expect(derived.map((m) => m.handler)).toEqual([
        BaseHooks.prototype.inherited,
        BaseHooks.prototype.overridden,
      ]);
    });

    it('does not report a decorated base method that an undecorated override hides', () => {
      const { found } = scanHookMethods([provider(new HidingHooks())]);
      expect(found.map((m) => m.name)).toEqual(['inherited']);
    });

    it('reports the override, not the base method, when the override is decorated again', () => {
      const { found } = scanHookMethods([provider(new RedecoratedHooks())]);
      const overridden = found.find((m) => m.name === 'overridden');
      expect(overridden?.handler).toBe(RedecoratedHooks.prototype.overridden);
      expect(overridden?.entries).toEqual([expect.objectContaining({ client: 'wisla' })]);
    });
  });

  describe('what is never read or reported', () => {
    it('does not run getters, and a getter that returns a hook is not a method', () => {
      let reads = 0;
      class WithGetters {
        get trap(): unknown {
          reads += 1;
          return Hooks.prototype.stacked;
        }
      }
      const instance = new WithGetters();
      Object.defineProperty(instance, 'own', {
        get() {
          reads += 1;
          return Hooks.prototype.stacked;
        },
        enumerable: true,
      });
      expect(scanHookMethods([provider(instance)])).toEqual({ found: [], problems: [] });
      expect(reads).toBe(0);
    });

    it('skips providers that are not class instances', () => {
      const knexLike = Object.assign(() => undefined, { stacked: Hooks.prototype.stacked });
      const scan = scanHookMethods([
        provider(undefined),
        provider(null),
        provider('a string'),
        provider(42),
        provider(knexLike),
      ]);
      expect(scan).toEqual({ found: [], problems: [] });
    });

    it('lists a shared instance once, however many providers lead to it (aliases)', () => {
      const hooks = new Hooks();
      const { found } = scanHookMethods([provider(hooks), provider(hooks), provider(hooks)]);
      expect(found).toHaveLength(2);
    });

    it('lists two instances of the same class separately: they are two providers', () => {
      const { found } = scanHookMethods([provider(new Hooks()), provider(new Hooks())]);
      expect(found).toHaveLength(4);
    });

    it('finds symbol-named methods and names them for diagnostics', () => {
      const name = Symbol('hook');
      class Symbolic {
        @ClientHook('kvitka', Service, 'run', 'after')
        [name](): void {
          calls.push('hook:symbol');
        }
      }
      expect(scanHookMethods([provider(new Symbolic())]).found.map((m) => m.name)).toEqual([
        'Symbol(hook)',
      ]);
    });
  });

  describe('scope', () => {
    it.each([
      ['request-scoped (non-static tree)', { staticTree: false }],
      ['transient', { transient: true }],
    ])('reports a %s provider that holds hooks, and ignores its hooks', (_name, scope) => {
      const { found, problems } = scanHookMethods([provider(new Hooks(), scope)]);
      expect(found).toEqual([]);
      expect(problems).toEqual([
        {
          code: 'unsupported-scope',
          message:
            'Hooks: its hook methods (stacked, second) cannot be used because the provider is request-scoped or transient',
        },
      ]);
    });

    it('does not report a non-singleton provider that holds no hooks', () => {
      const scan = scanHookMethods([
        provider(new Service(), { staticTree: false }),
        provider(new OtherService(), { transient: true }),
      ]);
      expect(scan).toEqual({ found: [], problems: [] });
    });

    it('still finds the hooks of the singletons around a non-singleton one', () => {
      const { found, problems } = scanHookMethods([
        provider(new Hooks(), { staticTree: false }),
        provider(new RedecoratedHooks()),
      ]);
      expect(found.map((m) => m.name)).toEqual(['overridden', 'inherited']);
      expect(codes(problems)).toEqual(['unsupported-scope']);
    });
  });

  describe('copying the metadata list (it is untrusted and must stay untouched)', () => {
    const entry = { client: 'kvitka', target: Service, method: 'run', phase: 'after' };

    /** A provider whose one method carries `list` as its @ClientHook metadata. */
    function withMetadata(list: unknown): { instance: object; handler: () => void } {
      class Forged {
        method(): void {
          calls.push('forged');
        }
      }
      Reflect.defineMetadata(CLIENT_HOOK_KEY, list, Forged.prototype.method);
      return { instance: new Forged(), handler: Forged.prototype.method };
    }

    const invalid = (list: unknown) => {
      const { instance } = withMetadata(list);
      const { found, problems } = scanHookMethods([provider(instance)]);
      expect(found).toEqual([]);
      expect(problems).toEqual([
        {
          code: 'invalid-hook-metadata',
          message: 'Forged.method: the @ClientHook metadata is not a list',
        },
      ]);
    };

    it('rejects a list with a throwing index accessor, without throwing', () => {
      const list: unknown[] = [entry];
      Object.defineProperty(list, 0, {
        get() {
          throw new Error('boom');
        },
      });
      invalid(list);
    });

    it('rejects a list with a side-effecting index accessor, without running it', () => {
      let reads = 0;
      const list: unknown[] = [entry];
      Object.defineProperty(list, 0, {
        get() {
          reads += 1;
          return entry;
        },
      });
      invalid(list);
      expect(reads).toBe(0);
    });

    it('rejects a list with a hole', () => {
      invalid([entry, , entry]); // eslint-disable-line no-sparse-arrays
    });

    it('returns a new ordinary array even if the list names a species that returns the list itself', () => {
      const list: unknown[] = [entry];
      Object.defineProperty(list, 'constructor', {
        value: {
          [Symbol.species]: function returnsOriginal() {
            return list;
          },
        },
      });
      const { instance } = withMetadata(list);
      const { found, problems } = scanHookMethods([provider(instance)]);

      expect(problems).toEqual([]);
      const copy = found[0].entries;
      expect(copy).not.toBe(list);
      expect(Array.isArray(copy)).toBe(true);
      expect(Object.getPrototypeOf(copy)).toBe(Array.prototype);
      expect(copy).toEqual([entry]);
    });

    it('returns an iterable array even if the list names a species that returns a non-array', () => {
      const list: unknown[] = [entry, entry];
      Object.defineProperty(list, 'constructor', {
        value: {
          [Symbol.species]: function returnsObject() {
            return {};
          },
        },
      });
      Object.defineProperty(list, Symbol.iterator, {
        value() {
          throw new Error("the list's own iterator must not be used");
        },
      });
      const { instance } = withMetadata(list);
      const copy = scanHookMethods([provider(instance)]).found[0].entries;

      expect(Array.isArray(copy)).toBe(true);
      expect([...copy]).toEqual([entry, entry]);
    });

    it('leaves the original list unchanged', () => {
      const list: unknown[] = [entry, { ...entry, client: 'wisla' }];
      const before = JSON.stringify(list.map((e) => ({ ...(e as object) }))) + list.length;
      const { instance } = withMetadata(list);
      const copy = scanHookMethods([provider(instance)]).found[0].entries as unknown[];
      copy.push('local change');
      expect(JSON.stringify(list.map((e) => ({ ...(e as object) }))) + list.length).toBe(before);
    });

    it('copies a normal stacked list as an independent, ordinary, iterable array in order', () => {
      const { found } = scanHookMethods([provider(new Hooks())]);
      const stored = Reflect.getOwnMetadata(CLIENT_HOOK_KEY, Hooks.prototype.stacked) as unknown[];
      const copy = found[0].entries;
      expect(copy).not.toBe(stored);
      expect(Object.getPrototypeOf(copy)).toBe(Array.prototype);
      expect([...copy]).toEqual(stored);
      expect(copy.map((e) => (e as { client: string }).client)).toEqual(['wisla', 'kvitka']);
    });
  });

  it('reports metadata that is not a list, without throwing', () => {
    class Forged {
      method(): void {
        calls.push('forged');
      }
    }
    Reflect.defineMetadata(CLIENT_HOOK_KEY, { client: 'kvitka' }, Forged.prototype.method);
    const { found, problems } = scanHookMethods([provider(new Forged())]);
    expect(found).toEqual([]);
    expect(problems).toEqual([
      {
        code: 'invalid-hook-metadata',
        message: 'Forged.method: the @ClientHook metadata is not a list',
      },
    ]);
  });
});

describe('findTargetInstances', () => {
  it('finds the instance whose prototype is exactly the target', () => {
    const service = new Service();
    const { found, problems } = findTargetInstances(
      [provider(new Hooks()), provider(service), provider(new OtherService())],
      Service,
    );
    expect(problems).toEqual([]);
    expect(found).toEqual([service]);
    expect(found[0]).toBe(service);
  });

  it('does not match a subclass instance, and does not match the target for a subclass', () => {
    const sub = new SubService();
    expect(codes(findTargetInstances([provider(sub)], Service).problems)).toEqual(['no-provider']);
    expect(findTargetInstances([provider(sub)], SubService).found).toEqual([sub]);
  });

  it('finds several instances of the class, each once, in provider order', () => {
    const [a, b] = [new Service(), new Service()];
    const { found, problems } = findTargetInstances(
      [provider(a), provider(a), provider(b), provider(a)],
      Service,
    );
    expect(problems).toEqual([]);
    expect(found).toEqual([a, b]);
  });

  it("does not trust or read an instance's own `constructor`", () => {
    const imposter = Object.assign(new OtherService(), { constructor: Service });
    const real = new Service();
    Object.defineProperty(real, 'constructor', {
      get() {
        throw new Error('must not be read');
      },
    });
    expect(findTargetInstances([provider(imposter), provider(real)], Service).found).toEqual([
      real,
    ]);
  });

  it('reports a missing provider', () => {
    const { found, problems } = findTargetInstances([provider(new OtherService())], Service);
    expect(found).toEqual([]);
    expect(problems).toEqual([
      {
        code: 'no-provider',
        message: 'Service: no provider of exactly this class exists in the application',
      },
    ]);
    expect(codes(findTargetInstances([], Service).problems)).toEqual(['no-provider']);
  });

  it.each([
    ['request-scoped', { staticTree: false }],
    ['transient', { transient: true }],
  ])('reports a %s instance instead of returning it', (_name, scope) => {
    const { found, problems } = findTargetInstances([provider(new Service(), scope)], Service);
    expect(found).toEqual([]);
    expect(problems).toEqual([
      {
        code: 'unsupported-scope',
        message:
          'Service: a provider of this class is request-scoped or transient and cannot be wrapped',
      },
    ]);
  });

  it('returns the singletons and reports the others when both exist', () => {
    const singleton = new Service();
    const { found, problems } = findTargetInstances(
      [provider(singleton), provider(new Service(), { staticTree: false })],
      Service,
    );
    expect(found).toEqual([singleton]);
    expect(codes(problems)).toEqual(['unsupported-scope']);
  });

  it('rejects a target that is not a class', () => {
    const arrow = (() => undefined) as unknown as typeof Service;
    expect(codes(findTargetInstances([provider(new Service())], arrow).problems)).toEqual([
      'unsupported-target',
    ]);
  });

  it('runs nothing', () => {
    findTargetInstances([provider(new Service()), provider(new Hooks())], Service);
    expect(calls).toEqual([]);
  });
});

/**
 * The same functions against the container Nest really builds, so the claims above (aliases,
 * several instances, factories, scopes, module narrowing) are not just about test doubles.
 */
describe('discovery in a real Nest container', () => {
  @Injectable()
  class Target {
    readonly ready = true;

    @Customizable()
    run(): Promise<number> {
      calls.push('core:run');
      return Promise.resolve(1);
    }
  }

  @Injectable({ scope: Scope.REQUEST })
  class RequestScopedTarget {
    readonly ready = true;

    @Customizable()
    run(): Promise<number> {
      return Promise.resolve(1);
    }
  }

  @Injectable({ scope: Scope.TRANSIENT })
  class TransientTarget {
    @Customizable()
    run(): Promise<number> {
      return Promise.resolve(1);
    }
  }

  /** A singleton by declaration, request-scoped in effect: it depends on a request-scoped class. */
  @Injectable()
  class DependsOnRequestScoped {
    constructor(@Inject(RequestScopedTarget) readonly scoped: RequestScopedTarget) {}

    @Customizable()
    run(): Promise<number> {
      return Promise.resolve(1);
    }
  }

  @Injectable()
  class KvitkaHooks {
    @ClientHook('kvitka', Target, 'run', 'after')
    addSomething(_hook: AfterHook<Target, 'run'>): void {
      calls.push('hook:kvitka');
    }
  }

  @Injectable()
  class WislaHooks {
    @ClientHook('wisla', Target, 'run', 'after')
    addSomethingElse(_hook: AfterHook<Target, 'run'>): void {
      calls.push('hook:wisla');
    }
  }

  @Injectable()
  class ScopedHooks {
    constructor(@Inject(RequestScopedTarget) readonly scoped: RequestScopedTarget) {
      void this.scoped;
    }

    @ClientHook('kvitka', Target, 'run', 'after')
    never(_hook: AfterHook<Target, 'run'>): void {
      calls.push('hook:never');
    }
  }

  const factoryBuilt = new OtherService();
  const shared = new Service();

  @Module({ providers: [Target, { provide: 'TARGET_ALIAS', useExisting: Target }] })
  class FirstModule {}

  @Module({ providers: [Target] }) // a second, independent instance of the same class
  class SecondModule {}

  @Module({
    providers: [
      KvitkaHooks,
      { provide: 'FACTORY', useFactory: () => factoryBuilt },
      { provide: 'VALUE', useValue: shared },
      { provide: 'PRIMITIVE', useValue: 'a string' },
    ],
  })
  class KvitkaModule {}

  @Module({ providers: [WislaHooks] })
  class WislaModule {}

  @Module({
    providers: [RequestScopedTarget, TransientTarget, DependsOnRequestScoped, ScopedHooks],
  })
  class ScopedModule {}

  @Controller('probe')
  class ProbeController {
    @Get()
    @Customizable()
    get(): Promise<string> {
      return Promise.resolve('x');
    }
  }

  @Resolver()
  class ProbeResolver {
    @Query(() => Int)
    @Customizable()
    probe(): Promise<number> {
      return Promise.resolve(1);
    }
  }

  @Module({
    imports: [
      GraphQLModule.forRoot<ApolloDriverConfig>({ driver: ApolloDriver, autoSchemaFile: true }),
    ],
    controllers: [ProbeController],
    providers: [ProbeResolver],
  })
  class EntryPointModule {}

  async function boot() {
    const moduleRef = await Test.createTestingModule({
      imports: [
        DiscoveryModule,
        FirstModule,
        SecondModule,
        KvitkaModule,
        WislaModule,
        ScopedModule,
        EntryPointModule,
      ],
    }).compile();
    const discovery = moduleRef.get(DiscoveryService);
    return { moduleRef, discovery, providers: discovery.getProviders() };
  }

  it('finds the hooks of exactly the modules it is given, with no code run', async () => {
    const { discovery, moduleRef } = await boot();
    calls.length = 0;

    const kvitka = scanHookMethods(discovery.getProviders({ include: [KvitkaModule] }));
    expect(kvitka.problems).toEqual([]);
    expect(kvitka.found.map((m) => m.name)).toEqual(['addSomething']);
    expect(kvitka.found[0].instance).toBe(moduleRef.get(KvitkaHooks, { strict: false }));

    const wisla = scanHookMethods(discovery.getProviders({ include: [WislaModule] }));
    expect(wisla.found.map((m) => m.name)).toEqual(['addSomethingElse']);

    expect(calls).toEqual([]);
    await moduleRef.close();
  });

  it('finds every instance of a target class, once each, across modules and aliases', async () => {
    const { moduleRef, providers } = await boot();
    const { found, problems } = findTargetInstances(providers, Target);

    expect(problems).toEqual([]);
    expect(found).toHaveLength(2); // one per module; the alias adds nothing
    const viaNest = moduleRef.get(Target, { strict: false, each: true });
    expect(new Set(found)).toEqual(new Set(viaNest));
    await moduleRef.close();
  });

  it('finds instances behind a factory or a value provider, by what they are', async () => {
    const { moduleRef, providers } = await boot();
    expect(findTargetInstances(providers, OtherService).found).toEqual([factoryBuilt]);
    expect(findTargetInstances(providers, Service).found).toEqual([shared]);
    await moduleRef.close();
  });

  it('reports request-scoped, transient and indirectly request-scoped targets', async () => {
    const { moduleRef, providers } = await boot();
    for (const target of [RequestScopedTarget, TransientTarget, DependsOnRequestScoped]) {
      const { found, problems } = findTargetInstances(providers, target);
      expect(found).toEqual([]);
      expect(codes(problems)).toEqual(['unsupported-scope']);
    }
    await moduleRef.close();
  });

  it('shows why: Nest keeps only a placeholder for a request-scoped provider', async () => {
    const { moduleRef, providers } = await boot();
    const wrapper = providers.find((w) => w.metatype === RequestScopedTarget);
    const placeholder = wrapper?.instance as object;
    // Made from the prototype, constructor never ran: a wrapper on it would serve no request.
    expect(Object.getPrototypeOf(placeholder)).toBe(RequestScopedTarget.prototype);
    expect(placeholder).not.toHaveProperty('ready');
    await moduleRef.close();
  });

  it('reports hooks that sit on a request-scoped provider, and only those', async () => {
    const { discovery, moduleRef } = await boot();
    const scoped = scanHookMethods(discovery.getProviders({ include: [ScopedModule] }));
    expect(scoped.found).toEqual([]);
    expect(scoped.problems).toEqual([
      {
        code: 'unsupported-scope',
        message:
          'ScopedHooks: its hook methods (never) cannot be used because the provider is request-scoped or transient',
      },
    ]);
    // The other scoped providers of the module hold no hooks and cause no report.
    expect(scoped.problems).toHaveLength(1);
    await moduleRef.close();
  });

  it('does not touch the container: scanning twice gives the same answer', async () => {
    const { providers, moduleRef } = await boot();
    const once = findTargetInstances(providers, Target);
    const twice = findTargetInstances(providers, Target);
    expect(twice).toEqual(once);
    await moduleRef.close();
  });

  it('rejects controllers and resolvers as targets, with the reason', async () => {
    const { moduleRef, providers } = await boot();
    for (const target of [ProbeController, ProbeResolver]) {
      const { found, problems } = findTargetInstances(providers, target);
      expect(found).toEqual([]);
      expect(codes(problems)).toEqual(['unsupported-target']);
      expect(problems[0].message).toContain('put the logic in a service');
    }
    await moduleRef.close();
  });
});

/**
 * Why controllers and resolvers are rejected as hook targets. The activator wraps during startup
 * (bootstrap), AFTER Nest has registered routes and resolvers, and a wrapper is an own property of
 * the instance. What Nest then does with a controller or resolver method depends on the kind:
 * - HTTP route: Nest reads `instance[method]` once, when it registers the route. A wrapper
 *   installed before that is used, one installed later is not. So it depends on the lifecycle.
 * - GraphQL resolver: Nest takes the method from the PROTOTYPE, so an instance wrapper is not used
 *   at any time.
 * Neither can be relied on from an activator that runs at bootstrap. The control case shows that
 * the same setup works for a service, which is called at request time through the instance.
 */
describe('hooks on entry points (the evidence for rejecting them)', () => {
  @Injectable()
  class Inner {
    @Customizable()
    value(): Promise<number> {
      return Promise.resolve(1);
    }
  }

  @Controller('probe')
  class ProbeController {
    constructor(@Inject(Inner) readonly inner: Inner) {}

    @Get('own')
    @Customizable()
    own(): Promise<{ n: number }> {
      return Promise.resolve({ n: 1 });
    }

    @Get('inner')
    async viaService(): Promise<{ n: number }> {
      return { n: await this.inner.value() };
    }
  }

  @Resolver()
  class ProbeResolver {
    constructor(@Inject(Inner) readonly inner: Inner) {}

    @Query(() => Int)
    @Customizable()
    own(): Promise<number> {
      return Promise.resolve(1);
    }

    @Query(() => Int)
    viaService(): Promise<number> {
      return this.inner.value();
    }
  }

  @Module({
    imports: [
      GraphQLModule.forRoot<ApolloDriverConfig>({ driver: ApolloDriver, autoSchemaFile: true }),
    ],
    controllers: [ProbeController],
    providers: [ProbeResolver, Inner],
  })
  class ProbeModule {}

  /** `beforeInit` runs after the providers exist but before Nest registers routes and resolvers. */
  async function bootApp(beforeInit?: (get: <T>(type: new (...args: never[]) => T) => T) => void) {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    beforeInit?.((type) => moduleRef.get(type));
    await app.init();
    const registry = new HookRegistry();
    const options = { registry, onHandlerError: () => undefined };
    return { app, registry, options };
  }

  const gql = async (app: Awaited<ReturnType<typeof bootApp>>['app'], field: string) =>
    (
      await request(app.getHttpServer() as never)
        .post('/graphql')
        .send({ query: `{ ${field} }` })
    ).body as { data: Record<string, number> };

  it('control: a hook on a service that a resolver calls does run, when wrapped after startup', async () => {
    const { app, registry, options } = await bootApp();
    registry.register(Inner, 'value', 'after', () => ({ result: 99 }));
    expect(wrapMethod(app.get(Inner), Inner, 'value', options)).toEqual({ ok: true });

    expect((await gql(app, 'viaService')).data.viaService).toBe(99);
    const http = await request(app.getHttpServer() as never).get('/probe/inner');
    expect(http.body).toEqual({ n: 99 });
    await app.close();
  });

  it('controller method wrapped after startup (as the activator would): the HTTP route does not use it', async () => {
    const { app, registry, options } = await bootApp();
    registry.register(ProbeController, 'own', 'after', () => ({ result: { n: 99 } }));
    const controller = app.get(ProbeController);
    expect(wrapMethod(controller, ProbeController, 'own', options)).toEqual({ ok: true });

    expect(await controller.own()).toEqual({ n: 99 }); // a direct call is hooked...
    const http = await request(app.getHttpServer() as never).get('/probe/own');
    expect(http.body).toEqual({ n: 1 }); // ...the route, registered earlier, is not
    await app.close();
  });

  it('controller method wrapped BEFORE the routes are registered: the HTTP route does use it (lifecycle-dependent)', async () => {
    const registry = new HookRegistry();
    registry.register(ProbeController, 'own', 'after', () => ({ result: { n: 99 } }));
    const { app } = await bootApp((get) => {
      const wrapped = wrapMethod(get(ProbeController), ProbeController, 'own', {
        registry,
        onHandlerError: () => undefined,
      });
      expect(wrapped).toEqual({ ok: true });
    });

    const http = await request(app.getHttpServer() as never).get('/probe/own');
    expect(http.body).toEqual({ n: 99 });
    await app.close();
  });

  it('resolver method wrapped after startup: GraphQL does not use it', async () => {
    const { app, registry, options } = await bootApp();
    registry.register(ProbeResolver, 'own', 'after', () => ({ result: 99 }));
    const resolver = app.get(ProbeResolver);
    expect(wrapMethod(resolver, ProbeResolver, 'own', options)).toEqual({ ok: true });

    expect(await resolver.own()).toBe(99);
    expect((await gql(app, 'own')).data.own).toBe(1);
    await app.close();
  });

  it('resolver method wrapped even BEFORE startup: GraphQL still does not use it (prototype)', async () => {
    const registry = new HookRegistry();
    registry.register(ProbeResolver, 'own', 'after', () => ({ result: 99 }));
    const { app } = await bootApp((get) => {
      const wrapped = wrapMethod(get(ProbeResolver), ProbeResolver, 'own', {
        registry,
        onHandlerError: () => undefined,
      });
      expect(wrapped).toEqual({ ok: true });
    });

    expect((await gql(app, 'own')).data.own).toBe(1);
    await app.close();
  });
});

describe('the test doubles match what Nest provides', () => {
  it('lets an InstanceWrapper be used as a ProviderLike (compile-time check)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DiscoveryModule] }).compile();
    const providers: ProviderLike[] = moduleRef.get(DiscoveryService).getProviders();
    expect(providers.length).toBeGreaterThan(0);
    await moduleRef.close();
  });
});
