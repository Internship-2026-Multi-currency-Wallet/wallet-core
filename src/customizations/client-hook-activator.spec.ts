import {
  Controller,
  Get,
  Global,
  Inject,
  Injectable,
  Module,
  type OnModuleInit,
  Scope,
} from '@nestjs/common';
import type { DynamicModule, INestApplication, Provider, Type } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import 'reflect-metadata';
import { AppConfig } from '../config/app-config.js';
import type { ClientCode } from '../config/env.schema.js';
import { httpLoggerOptions } from '../logging/logger.options.js';
import { ClientHookActivator, type ModuleClass, failureFields } from './client-hook-activator.js';
import { CLIENT_HOOK_KEY, ClientHook } from './client-hook.decorator.js';
import { Customizable } from './customizable.decorator.js';
import { CustomizationsCoreModule } from './customizations-core.module.js';
import { HookRegistry } from './hook-registry.js';
import type { ArgsReplacement, HookFailure, ResultReplacement } from './hook-runner.js';
import type { AfterHook, BeforeHook } from './hook.types.js';

/* -------------------------------------------------------------------------------------------- *
 * Fixtures. Everything here is test-only: a fake target service, one fake hook class per client,
 * and the Nest modules that subscribe them the way real client modules will.
 * -------------------------------------------------------------------------------------------- */

/** What happened in ONE application, in order. A provider, so every app gets its own. */
@Injectable()
class CallLog {
  readonly entries: string[] = [];
  readonly constructed: string[] = [];

  count(prefix: string): number {
    return this.entries.filter((entry) => entry.startsWith(prefix)).length;
  }
}

/** The service the hooks target (a stand-in for a real ConversionService). */
@Injectable()
class Converter {
  constructor(@Inject(CallLog) private readonly log: CallLog) {}

  @Customizable()
  convert(amount: number): Promise<number> {
    this.log.entries.push(`core:${amount}`);
    return Promise.resolve(amount * 10);
  }

  @Customizable({ propagateExceptions: true })
  strict(amount: number): Promise<number> {
    this.log.entries.push('core:strict');
    return Promise.resolve(amount);
  }

  @Customizable()
  fail(): Promise<number> {
    this.log.entries.push('core:fail');
    return Promise.reject(new Error('core failure'));
  }
}

@Injectable()
class KvitkaHooks {
  constructor(@Inject(CallLog) private readonly log: CallLog) {
    log.constructed.push('kvitka');
  }

  @ClientHook('kvitka', Converter, 'convert', 'before')
  observeBefore(_hook: BeforeHook<Converter, 'convert'>): void {
    this.log.entries.push('kvitka:before:observe');
  }

  @ClientHook('kvitka', Converter, 'convert', 'before')
  bump({ args }: BeforeHook<Converter, 'convert'>): ArgsReplacement<[amount: number]> {
    this.log.entries.push('kvitka:before:bump');
    return { args: [args[0] + 1] };
  }

  @ClientHook('kvitka', Converter, 'convert', 'after')
  double({ result }: AfterHook<Converter, 'convert'>): ResultReplacement<number> {
    this.log.entries.push('kvitka:after:double');
    return { result: result * 2 };
  }

  @ClientHook('kvitka', Converter, 'convert', 'after')
  observeAfter(_hook: AfterHook<Converter, 'convert'>): void {
    this.log.entries.push('kvitka:after:observe');
  }
}

@Injectable()
class WislaHooks {
  constructor(@Inject(CallLog) private readonly log: CallLog) {
    log.constructed.push('wisla');
  }

  @ClientHook('wisla', Converter, 'convert', 'before')
  observeBefore(_hook: BeforeHook<Converter, 'convert'>): void {
    this.log.entries.push('wisla:before:observe');
  }

  @ClientHook('wisla', Converter, 'convert', 'after')
  plusOne({ result }: AfterHook<Converter, 'convert'>): ResultReplacement<number> {
    this.log.entries.push('wisla:after:plus');
    return { result: result + 1 };
  }
}

@Injectable()
class DemoHooks {
  constructor(@Inject(CallLog) private readonly log: CallLog) {
    log.constructed.push('demo');
  }

  @ClientHook('demo', Converter, 'convert', 'after')
  plusThousand({ result }: AfterHook<Converter, 'convert'>): ResultReplacement<number> {
    this.log.entries.push('demo:after:plus');
    return { result: result + 1000 };
  }
}

const STRICT_ERROR = new Error('strict hook failure');

class LeakyError extends Error {
  readonly token = 'Bearer abc.def.ghi';
}

/** Hooks that fail, with messages, properties and context that must never reach the logs. */
@Injectable()
class FailingHooks {
  constructor(@Inject(CallLog) private readonly log: CallLog) {}

  @ClientHook('kvitka', Converter, 'convert', 'before')
  setsContext({ ctx }: BeforeHook<Converter, 'convert'>): void {
    ctx.token = 'ctx-secret-xyz';
  }

  @ClientHook('kvitka', Converter, 'convert', 'before')
  failingBefore(): void {
    throw new LeakyError('password=hunter2 for user 987654321');
  }

  @ClientHook('kvitka', Converter, 'convert', 'after')
  throwsString(): void {
    // A non-Error on purpose: hooks are first-party code, but a thrown string must not be logged.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw 'password=hunter2';
  }

  @ClientHook('kvitka', Converter, 'strict', 'before')
  failingStrict(): void {
    throw STRICT_ERROR;
  }

  @ClientHook('kvitka', Converter, 'fail', 'after')
  afterFail(): void {
    this.log.entries.push('after:fail');
  }
}

@Controller('probe')
class ProbeController {
  constructor(@Inject(Converter) private readonly converter: Converter) {}

  @Get()
  async get(): Promise<{ value: number }> {
    return { value: await this.converter.convert(7) };
  }
}

@Module({ providers: [Converter], controllers: [ProbeController], exports: [Converter] })
class TargetModule {}

/** A second module that lists the same class: Nest builds a second, independent instance. */
@Module({ providers: [Converter] })
class SecondTargetModule {}

/**
 * A client module the way real ones are written: it checks the configured client in `onModuleInit`
 * and only then subscribes itself. `always` builds the broken variant that forgot the check.
 */
function clientModule(
  client: ClientCode,
  providers: Provider[],
  extras: { always?: boolean; controllers?: Type[] } = {},
): Type {
  class FixtureClientModule implements OnModuleInit {
    constructor(
      @Inject(AppConfig) private readonly config: AppConfig,
      @Inject(ClientHookActivator) private readonly activator: ClientHookActivator,
    ) {}

    onModuleInit(): void {
      if (!extras.always && this.config.client !== client) return;
      this.activator.subscribe(FixtureClientModule);
    }
  }
  Module({
    imports: [CustomizationsCoreModule],
    providers,
    controllers: extras.controllers ?? [],
  })(FixtureClientModule);
  return FixtureClientModule;
}

@Global()
@Module({})
class SupportModule {}

interface LogLine {
  msg?: string;
  [key: string]: unknown;
}

interface Prepared {
  app: INestApplication;
  moduleRef: TestingModule;
  config: AppConfig;
  lines: () => LogLine[];
}

/**
 * nestjs-pino keeps ONE logger per process (the first application to log creates it and every later
 * application reuses it), so all applications of this file share one sink and one set of logger
 * settings; each test reads the lines written since its application was prepared. That is also why
 * `client` is not asserted on log lines: it is a base field of that first logger.
 */
const written: string[] = [];
const sink = { write: (line: string) => void written.push(line) };
const LOGGER_SETTINGS = {
  service: 'wallet-core',
  appEnv: 'local',
  client: 'kvitka',
  level: 'info' as const,
  pretty: false,
};

const apps: INestApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** A Nest app (not yet initialised) for `client`, with a real pino logger writing to memory. */
async function prepare(client: ClientCode, imports: Type[]): Promise<Prepared> {
  const config = AppConfig.fromEnv({ CLIENT: client, LOG_LEVEL: 'info', NODE_ENV: 'test' });
  const startAt = written.length;
  const support: DynamicModule = {
    module: SupportModule,
    global: true,
    providers: [{ provide: AppConfig, useValue: config }, CallLog],
    exports: [AppConfig, CallLog],
  };
  const moduleRef = await Test.createTestingModule({
    imports: [
      support,
      LoggerModule.forRoot({ pinoHttp: [httpLoggerOptions(LOGGER_SETTINGS), sink] }),
      ...imports,
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  apps.push(app);
  return {
    app,
    moduleRef,
    config,
    lines: () => written.slice(startAt).map((line) => JSON.parse(line) as LogLine),
  };
}

async function boot(client: ClientCode, imports: Type[]) {
  const prepared = await prepare(client, imports);
  await prepared.app.init();
  return view(prepared);
}

function view({ app, moduleRef, lines }: Prepared) {
  return {
    app,
    moduleRef,
    lines,
    log: app.get(CallLog),
    registry: app.get(HookRegistry, { strict: false }),
    converter: moduleRef.get(Converter, { strict: false }),
    byMessage: (msg: string) => lines().filter((line) => line.msg === msg),
  };
}

const failedMessage = 'client hook failed and was ignored';

/* -------------------------------------------------------------------------------------------- */

describe("only the active client's hooks are registered and executed", () => {
  const allClients = (): Type[] => [
    TargetModule,
    clientModule('kvitka', [KvitkaHooks]),
    clientModule('wisla', [WislaHooks]),
    clientModule('demo', [DemoHooks]),
  ];

  const expected = {
    kvitka: {
      result: 120, // (5 + 1) * 10, doubled
      calls: [
        'kvitka:before:observe',
        'kvitka:before:bump',
        'core:6',
        'kvitka:after:double',
        'kvitka:after:observe',
      ],
      registered: { before: 2, after: 2 },
      summary: { hooks: 4, methods: 1 },
    },
    wisla: {
      result: 51,
      calls: ['wisla:before:observe', 'core:5', 'wisla:after:plus'],
      registered: { before: 1, after: 1 },
      summary: { hooks: 2, methods: 1 },
    },
    demo: {
      result: 1050,
      calls: ['core:5', 'demo:after:plus'],
      registered: { before: 0, after: 1 },
      summary: { hooks: 1, methods: 1 },
    },
  } as const;

  describe.each(['kvitka', 'wisla', 'demo'] as const)('CLIENT=%s', (client) => {
    const others = (['kvitka', 'wisla', 'demo'] as const).filter((c) => c !== client);

    it("activation runs no code, but every client's hook provider is still constructed", async () => {
      const { log } = await boot(client, allClients());
      expect(log.entries).toEqual([]);
      expect([...log.constructed].sort()).toEqual(['demo', 'kvitka', 'wisla']);
    });

    it("runs exactly this client's hooks, in order, and changes args and result", async () => {
      const { converter, log } = await boot(client, allClients());

      expect(await converter.convert(5)).toBe(expected[client].result);
      expect(log.entries).toEqual(expected[client].calls);
    });

    it("never calls another client's handler: zero invocations, however often it is called", async () => {
      const { converter, log } = await boot(client, allClients());

      await converter.convert(5);
      await converter.convert(5);

      for (const other of others) expect(log.count(`${other}:`)).toBe(0);
      expect(log.entries).toEqual([...expected[client].calls, ...expected[client].calls]);
    });

    it("registers only this client's handlers", async () => {
      const { registry } = await boot(client, allClients());
      const { before, after } = registry.erasedHandlersFor(Converter, 'convert');
      expect({ before: before.length, after: after.length }).toEqual(expected[client].registered);
    });

    it('logs one summary line', async () => {
      const { byMessage } = await boot(client, allClients());
      expect(byMessage('client hooks activated')).toEqual([
        expect.objectContaining({ ...expected[client].summary, level: 'info' }),
      ]);
    });
  });

  it('CLIENT=demo with no demo module: neither Kvitka nor Wisla runs, and nothing is wrapped', async () => {
    const { converter, log, registry, byMessage } = await boot('demo', [
      TargetModule,
      clientModule('kvitka', [KvitkaHooks]),
      clientModule('wisla', [WislaHooks]),
    ]);

    expect(await converter.convert(5)).toBe(50);
    expect(log.entries).toEqual(['core:5']);
    expect(Object.hasOwn(converter, 'convert')).toBe(false);
    expect(registry.erasedHandlersFor(Converter, 'convert').after).toEqual([]);
    expect(byMessage('client hooks activated')).toEqual([
      expect.objectContaining({ hooks: 0, methods: 0, level: 'info' }),
    ]);
  });

  it('keeps two applications of different clients in one process apart', async () => {
    const [kvitka, wisla] = await Promise.all([
      boot('kvitka', allClients()),
      boot('wisla', allClients()),
    ]);

    const results = await Promise.all([
      kvitka.converter.convert(5),
      wisla.converter.convert(5),
      kvitka.converter.convert(5),
      wisla.converter.convert(5),
    ]);

    expect(results).toEqual([120, 51, 120, 51]);
    expect(kvitka.log.count('wisla:')).toBe(0);
    expect(wisla.log.count('kvitka:')).toBe(0);
    expect(kvitka.log.count('kvitka:after:double')).toBe(2);
    expect(wisla.log.count('wisla:after:plus')).toBe(2);
  });

  it('wraps every instance of the target class, one per module that lists it', async () => {
    const { moduleRef, log } = await boot('kvitka', [
      TargetModule,
      SecondTargetModule,
      clientModule('kvitka', [KvitkaHooks]),
    ]);
    const instances = moduleRef.get(Converter, { strict: false, each: true });
    expect(instances).toHaveLength(2);

    expect(await Promise.all(instances.map((c) => c.convert(5)))).toEqual([120, 120]);
    expect(log.count('kvitka:after:double')).toBe(2);
  });

  it('ignores a second subscription of the same module', async () => {
    // A client module that (wrongly or defensively) subscribes itself twice from onModuleInit.
    const subscriptions: string[] = [];
    @Module({ imports: [CustomizationsCoreModule], providers: [KvitkaHooks] })
    class TwiceModule implements OnModuleInit {
      constructor(@Inject(ClientHookActivator) private readonly activator: ClientHookActivator) {}

      onModuleInit(): void {
        this.activator.subscribe(TwiceModule);
        this.activator.subscribe(TwiceModule);
        subscriptions.push('subscribed twice');
      }
    }

    const { converter, log, registry, byMessage } = await boot('kvitka', [
      TargetModule,
      TwiceModule,
    ]);

    expect(subscriptions).toEqual(['subscribed twice']);
    expect(await converter.convert(5)).toBe(120);
    expect(log.count('kvitka:after:double')).toBe(1);
    expect(registry.erasedHandlersFor(Converter, 'convert').after).toHaveLength(2);
    expect(byMessage('client hooks activated')).toEqual([
      expect.objectContaining({ hooks: 4, methods: 1 }),
    ]);
  });
});

describe('exceptions and safe error reporting', () => {
  const clients = (): Type[] => [TargetModule, clientModule('kvitka', [FailingHooks])];

  it('ignores a failing hook by default, keeps going, and reports only safe fields', async () => {
    const { converter, byMessage } = await boot('kvitka', clients());

    expect(await converter.convert(987654321)).toBe(9876543210);

    const failures = byMessage(failedMessage);
    expect(failures).toHaveLength(2);
    const common = { level: 'error', target: 'Converter', method: 'convert' };
    expect(failures[0]).toMatchObject({
      ...common,
      phase: 'before',
      index: 1,
      handler: 'failingBefore',
      errorType: 'Error',
    });
    expect(failures[1]).toMatchObject({
      ...common,
      phase: 'after',
      index: 0,
      handler: 'throwsString',
      errorType: 'string',
    });
  });

  it('writes nothing from the error, the arguments, the result or the context to the log', async () => {
    const { converter, lines } = await boot('kvitka', clients());
    await converter.convert(987654321);

    const text = JSON.stringify(lines());
    for (const secret of ['hunter2', 'abc.def.ghi', 'ctx-secret-xyz', '987654321']) {
      expect(text).not.toContain(secret);
    }
    const failure = lines().find((line) => line.msg === failedMessage) as LogLine;
    expect(Object.keys(failure).sort()).toEqual(
      [
        'appEnv',
        'client',
        'context',
        'errorType',
        'handler',
        'index',
        'level',
        'method',
        'msg',
        'phase',
        'service',
        'target',
        'time',
      ].sort(),
    );
    expect(failure.context).toBe('ClientHookActivator');
  });

  it("with propagateExceptions rethrows the hook's own error, skips the core method, logs nothing here", async () => {
    const { converter, log, byMessage } = await boot('kvitka', clients());

    await expect(converter.strict(3)).rejects.toBe(STRICT_ERROR);
    expect(log.count('core:strict')).toBe(0);
    expect(byMessage(failedMessage)).toEqual([]);
  });

  it('propagates a core error unchanged and runs no after hook', async () => {
    const { converter, log, byMessage } = await boot('kvitka', clients());

    await expect(converter.fail()).rejects.toThrow('core failure');
    expect(log.entries).toEqual(['core:fail']);
    expect(byMessage(failedMessage)).toEqual([]);
  });

  it('puts the request id on the report when the failing call happens inside a request', async () => {
    const { app, byMessage } = await boot('kvitka', clients());

    const response = await request(app.getHttpServer() as App)
      .get('/probe')
      .set('x-request-id', 'req-123');

    expect(response.body).toEqual({ value: 70 });
    const reports = byMessage(failedMessage);
    expect(reports).toHaveLength(2);
    expect(reports.every((r) => r.requestId === 'req-123')).toBe(true);
  });

  it('survives a logger that fails: the call still returns its result', async () => {
    const prepared = await prepare('kvitka', clients());
    await prepared.app.init();
    const { converter } = view(prepared);
    const activator = prepared.app.get(ClientHookActivator, { strict: false });
    const logger = (activator as unknown as { logger: { error: () => void } }).logger;
    logger.error = () => {
      throw new Error('logger down');
    };
    expect(await converter.convert(5)).toBe(50);
  });
});

describe('failureFields', () => {
  const failure = (error: unknown, handler = 'bound hook'): HookFailure => ({
    phase: 'after',
    index: 3,
    handler,
    error,
  });

  it('describes a failure by phase, position, handler name and a fixed error category only', () => {
    expect(failureFields(failure(new LeakyError('secret message')))).toEqual({
      phase: 'after',
      index: 3,
      handler: 'hook',
      errorType: 'Error',
    });
  });

  it.each([
    ['a string', 'password=hunter2', 'string'],
    ['undefined', undefined, 'undefined'],
    ['a number', 5, 'number'],
    ['null', null, 'object'],
    ['an object without a prototype', Object.create(null) as object, 'object'],
  ])('names a thrown %s by its type', (_name, error, expectedType) => {
    expect(failureFields(failure(error)).errorType).toBe(expectedType);
  });

  it("never reads the error's message, stack or other properties", () => {
    const error = new Error('x');
    const reads: string[] = [];
    for (const key of ['message', 'stack', 'cause', 'name', 'token']) {
      Object.defineProperty(error, key, {
        get() {
          reads.push(key);
          return 'secret';
        },
      });
    }
    expect(failureFields(failure(error)).errorType).toBe('Error');
    expect(reads).toEqual([]);
  });

  it('does not trust handler names that are not identifiers, or an error that cannot be inspected', () => {
    class Odd extends Error {}
    Object.defineProperty(Odd, 'name', { value: 'Bearer abc def' });
    expect(failureFields(failure(new Odd('x'))).errorType).toBe('Error');

    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('trap');
        },
      },
    );
    expect(failureFields(failure(hostile)).errorType).toBe('unknown');

    expect(failureFields(failure(new Error('x'), 'two words')).handler).toBe('(unnamed handler)');
    expect(failureFields(failure(new Error('x'), 'bound bound twice_')).handler).toBe('twice_');
  });
});

describe('activation failures: startup rejects and nothing is activated', () => {
  class Unprovided {
    @Customizable()
    run(): Promise<number> {
      return Promise.resolve(1);
    }
  }

  @Injectable()
  class UnprovidedHooks {
    @ClientHook('kvitka', Unprovided, 'run', 'after')
    hook(): void {}
  }

  @Injectable()
  class Plain {
    run(): Promise<number> {
      return Promise.resolve(1);
    }
  }

  @Injectable()
  class PlainHooks {
    @ClientHook('kvitka', Plain, 'run', 'after')
    hook(): void {}
  }

  @Injectable()
  class WrongClientHooks {
    @ClientHook('wisla', Converter, 'convert', 'after')
    hook(): void {}
  }

  @Injectable({ scope: Scope.REQUEST })
  class Scoped {
    @Customizable()
    run(): Promise<number> {
      return Promise.resolve(1);
    }
  }

  @Injectable()
  class ScopedHooks {
    @ClientHook('kvitka', Scoped, 'run', 'after')
    hook(): void {}
  }

  @Controller('entry')
  class EntryPoint {
    @Get()
    @Customizable()
    run(): Promise<number> {
      return Promise.resolve(1);
    }
  }

  @Injectable()
  class EntryPointHooks {
    @ClientHook('kvitka', EntryPoint, 'run', 'after')
    hook(): void {}
  }

  const cases: [string, () => Type[], RegExp][] = [
    [
      'a target class with no provider',
      () => [TargetModule, clientModule('kvitka', [KvitkaHooks, UnprovidedHooks])],
      /Unprovided: no provider of exactly this class exists/,
    ],
    [
      'a target method without @Customizable()',
      () => [TargetModule, clientModule('kvitka', [KvitkaHooks, PlainHooks, Plain])],
      /Plain\.run.*is not marked @Customizable\(\)/,
    ],
    [
      'a hook written for another client',
      () => [TargetModule, clientModule('kvitka', [KvitkaHooks, WrongClientHooks])],
      /belongs to client "wisla", but the active client is "kvitka"/,
    ],
    [
      'a request-scoped target',
      () => [TargetModule, clientModule('kvitka', [KvitkaHooks, ScopedHooks, Scoped])],
      /Scoped: a provider of this class is request-scoped or transient/,
    ],
    [
      'a controller as target',
      () => [
        TargetModule,
        clientModule('kvitka', [KvitkaHooks, EntryPointHooks], { controllers: [EntryPoint] }),
      ],
      /EntryPoint: a controller or resolver cannot be a hook target/,
    ],
    [
      'the same hook provider subscribed twice (it would run twice)',
      () => [
        TargetModule,
        clientModule('kvitka', [KvitkaHooks]),
        clientModule('kvitka', [KvitkaHooks]),
      ],
      /KvitkaHooks\.\w+: more than one instance of this hook provider is subscribed/,
    ],
    [
      'a module that forgot its client check (Wisla hooks under CLIENT=kvitka)',
      () => [TargetModule, clientModule('wisla', [WislaHooks], { always: true })],
      /belongs to client "wisla", but the active client is "kvitka"/,
    ],
  ];

  it.each(cases)('%s', async (_name, imports, message) => {
    const prepared = await prepare('kvitka', imports());
    const { converter, registry, byMessage } = view(prepared);

    await expect(prepared.app.init()).rejects.toThrow(message);

    // Preflight failed: no wrapper anywhere, no handler registered, valid hooks included.
    expect(Object.hasOwn(converter, 'convert')).toBe(false);
    expect(registry.erasedHandlersFor(Converter, 'convert')).toEqual({ before: [], after: [] });
    const [report] = byMessage('client hook activation failed');
    expect(report).toMatchObject({ level: 'error', problems: expect.any(Array) });
    expect(byMessage('client hooks activated')).toEqual([]);
  });

  it('lists every problem in one error', async () => {
    const prepared = await prepare('kvitka', [
      TargetModule,
      clientModule('kvitka', [KvitkaHooks, PlainHooks, Plain, WrongClientHooks, UnprovidedHooks]),
    ]);
    const error = await prepared.app.init().then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toMatch(
      /^Client hook activation failed for client "kvitka" \(3 problems\):/,
    );
    expect(error?.message).toContain('Plain.run');
    expect(error?.message).toContain('belongs to client "wisla"');
    expect(error?.message).toContain('Unprovided');
  });

  it('refuses a subscription that comes too late, or is not a module class', async () => {
    const { app } = await boot('kvitka', [TargetModule, clientModule('kvitka', [KvitkaHooks])]);
    const activator = app.get(ClientHookActivator, { strict: false });

    expect(() => activator.subscribe(TargetModule)).toThrow(/too late/);
    expect(() => activator.subscribe('x' as unknown as ModuleClass)).toThrow(TypeError);
  });

  describe('a wrapper cannot be installed after a successful preflight', () => {
    class Fragile {
      @Customizable()
      run(): Promise<number> {
        return Promise.resolve(1);
      }
    }

    @Injectable()
    class FragileHooks {
      @ClientHook('kvitka', Converter, 'convert', 'after')
      first(_hook: AfterHook<Converter, 'convert'>): void {}

      @ClientHook('kvitka', Fragile, 'run', 'after')
      second(_hook: AfterHook<Fragile, 'run'>): void {}
    }

    // A proxy passes every preflight check and only refuses the final definition.
    const fragile = new Proxy(new Fragile(), {
      defineProperty() {
        throw new Error('secret trap failure');
      },
    });

    it('startup rejects, no handler is registered, and the earlier wrapper only passes calls through', async () => {
      const prepared = await prepare('kvitka', [
        TargetModule,
        clientModule('kvitka', [FragileHooks, { provide: Fragile, useValue: fragile }]),
      ]);
      const { converter, registry, log, byMessage } = view(prepared);

      const error = await prepared.app.init().then(
        () => undefined,
        (caught: unknown) => caught as Error,
      );

      expect(error?.message).toMatch(/while installing wrappers: Fragile\.run/);
      expect(error?.message).toContain('No client hook was registered');
      expect(error?.message).not.toContain('secret trap');
      expect(JSON.stringify(prepared.lines())).not.toContain('secret trap');
      expect(byMessage('client hook activation failed')).toHaveLength(1);

      // Not atomic, and said so: the first wrapper stayed. But the registry is empty, so no
      // client handler is active anywhere, and the wrapped method behaves as before.
      expect(Object.hasOwn(converter, 'convert')).toBe(true);
      expect(registry.erasedHandlersFor(Converter, 'convert')).toEqual({ before: [], after: [] });
      expect(registry.erasedHandlersFor(Fragile, 'run')).toEqual({ before: [], after: [] });
      expect(await converter.convert(5)).toBe(50);
      expect(log.entries).toEqual(['core:5']);
    });
  });
});

describe('the subscribed module must exist in the application', () => {
  class MissingModule {}

  @Module({ imports: [CustomizationsCoreModule] })
  class QuietModule implements OnModuleInit {
    constructor(@Inject(ClientHookActivator) private readonly activator: ClientHookActivator) {}

    onModuleInit(): void {
      this.activator.subscribe(QuietModule);
    }
  }

  function subscribing(subscribed: ModuleClass, providers: Provider[] = []): Type {
    @Module({ imports: [CustomizationsCoreModule], providers })
    class Subscriber implements OnModuleInit {
      constructor(@Inject(ClientHookActivator) private readonly activator: ClientHookActivator) {}

      onModuleInit(): void {
        this.activator.subscribe(subscribed);
      }
    }
    return Subscriber;
  }

  it('fails startup when a module that is not part of the application is subscribed', async () => {
    const prepared = await prepare('kvitka', [
      TargetModule,
      subscribing(MissingModule, [KvitkaHooks]),
    ]);
    const { converter, registry, byMessage } = view(prepared);

    await expect(prepared.app.init()).rejects.toThrow(
      /MissingModule: this module is not part of the application/,
    );

    expect(Object.hasOwn(converter, 'convert')).toBe(false);
    expect(registry.erasedHandlersFor(Converter, 'convert')).toEqual({ before: [], after: [] });
    expect(byMessage('client hook activation failed')).toHaveLength(1);
    expect(byMessage('client hooks activated')).toEqual([]);
  });

  it('also rejects a class that is not a module at all (a provider class)', async () => {
    const prepared = await prepare('kvitka', [TargetModule, subscribing(Converter)]);
    await expect(prepared.app.init()).rejects.toThrow(
      /Converter: this module is not part of the application/,
    );
  });

  it('reports a missing module together with the other problems', async () => {
    const prepared = await prepare('kvitka', [
      TargetModule,
      clientModule('wisla', [WislaHooks], { always: true }),
      subscribing(MissingModule),
    ]);
    const error = await prepared.app.init().then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toMatch(/\(3 problems\):/);
    expect(error?.message).toContain('MissingModule: this module is not part of the application');
    expect(error?.message).toContain('belongs to client "wisla"');
  });

  it('still accepts a registered module that has no hook providers at all', async () => {
    const { converter, registry, byMessage } = await boot('kvitka', [TargetModule, QuietModule]);

    expect(registry.erasedHandlersFor(Converter, 'convert')).toEqual({ before: [], after: [] });
    expect(await converter.convert(5)).toBe(50);
    expect(byMessage('client hooks activated')).toEqual([
      expect.objectContaining({ hooks: 0, methods: 0 }),
    ]);
  });
});

describe('hook providers that share an inherited handler', () => {
  @Injectable()
  class SharedHooks {
    readonly label: string = 'base';

    constructor(@Inject(CallLog) private readonly log: CallLog) {}

    @ClientHook('kvitka', Converter, 'convert', 'after')
    record(_hook: AfterHook<Converter, 'convert'>): void {
      this.log.entries.push(`shared:${this.label}`);
    }
  }

  @Injectable()
  class FirstSharedHooks extends SharedHooks {
    override readonly label = 'first';
  }

  @Injectable()
  class SecondSharedHooks extends SharedHooks {
    override readonly label = 'second';
  }

  it('accepts two different concrete classes that inherit the same decorated method', async () => {
    const { converter, log, registry, byMessage } = await boot('kvitka', [
      TargetModule,
      clientModule('kvitka', [FirstSharedHooks, SecondSharedHooks]),
    ]);

    expect(FirstSharedHooks.prototype.record).toBe(SecondSharedHooks.prototype.record);
    expect(registry.erasedHandlersFor(Converter, 'convert').after).toHaveLength(2);
    expect(byMessage('client hooks activated')).toEqual([
      expect.objectContaining({ hooks: 2, methods: 1 }),
    ]);

    // One run per receiver: each instance's own `this`, once.
    expect(await converter.convert(5)).toBe(50);
    expect(log.entries).toEqual(['core:5', 'shared:first', 'shared:second']);
  });

  it('still rejects two instances of the SAME concrete class (they would both run)', async () => {
    const prepared = await prepare('kvitka', [
      TargetModule,
      clientModule('kvitka', [FirstSharedHooks]),
      clientModule('kvitka', [FirstSharedHooks, SecondSharedHooks]),
    ]);
    const { converter, registry } = view(prepared);

    await expect(prepared.app.init()).rejects.toThrow(
      /FirstSharedHooks\.record: more than one instance of this hook provider is subscribed/,
    );
    expect(Object.hasOwn(converter, 'convert')).toBe(false);
    expect(registry.erasedHandlersFor(Converter, 'convert')).toEqual({ before: [], after: [] });
  });
});

describe('diagnostics never repeat identifier-shaped untrusted values', () => {
  // Shaped like an identifier on purpose: a format check cannot tell it from a class name.
  const SECRETS = ['sk_live_AbC123xyz789', 'tok_Zq81LmN0pQ', 'pw_hunter2_Rt5', 'key_77Hh0aBcD'];

  function namedClass(base: new () => Error, name: string): new () => Error {
    const named = class extends base {};
    Object.defineProperty(named, 'name', { value: name });
    return named;
  }

  describe('the error type of an ignored hook failure is a fixed category', () => {
    const failure = (error: unknown): HookFailure => ({
      phase: 'after',
      index: 0,
      handler: 'hook',
      error,
    });

    it('does not use the error class name, whatever it looks like', () => {
      const Secretive = namedClass(Error, SECRETS[0]);
      expect(failureFields(failure(new Secretive())).errorType).toBe('Error');
      const SecretiveType = namedClass(TypeError, SECRETS[1]);
      expect(failureFields(failure(new SecretiveType())).errorType).toBe('TypeError');
    });

    it('does not use the constructor name of a plain object either', () => {
      const lookalike = Object.create({
        constructor: Object.defineProperty(function () {}, 'name', { value: SECRETS[2] }),
      }) as object;
      expect(failureFields(failure(lookalike)).errorType).toBe('object');
    });

    it('reports a subclass of a built-in error as that built-in, and a custom error as Error', () => {
      expect(failureFields(failure(new RangeError('x'))).errorType).toBe('RangeError');
      expect(failureFields(failure(new LeakyError('x'))).errorType).toBe('Error');
    });
  });

  it('keeps an error class named like a secret out of the log', async () => {
    @Injectable()
    class SecretiveHooks {
      @ClientHook('kvitka', Converter, 'convert', 'after')
      throws(): void {
        const Secretive = namedClass(Error, SECRETS[0]);
        throw new Secretive();
      }
    }
    const { converter, lines, byMessage } = await boot('kvitka', [
      TargetModule,
      clientModule('kvitka', [SecretiveHooks]),
    ]);

    await converter.convert(1);

    expect(byMessage(failedMessage)).toEqual([expect.objectContaining({ errorType: 'Error' })]);
    expect(JSON.stringify(lines())).not.toContain(SECRETS[0]);
  });

  describe('startup diagnostics do not repeat values taken from hook metadata', () => {
    const [client, target, method, phase] = SECRETS;

    /** A hook provider whose metadata was forged (or damaged) after the decorators ran. */
    function forged(entry: Record<string, unknown>): Type {
      @Injectable()
      class ForgedHooks {
        hook(): void {}
      }
      Reflect.defineMetadata(CLIENT_HOOK_KEY, [entry], ForgedHooks.prototype.hook);
      return ForgedHooks;
    }
    const valid = { client: 'kvitka', target: Converter, method: 'convert', phase: 'after' };

    it.each([
      ['client', { ...valid, client }, client],
      ['phase', { ...valid, phase }, phase],
      ['method', { ...valid, method }, method],
      ['target', { ...valid, target }, target],
      ['everything at once', { client, target, method, phase }, SECRETS.join('|')],
    ])('does not echo a %s value', async (_name, entry, secretPattern) => {
      const prepared = await prepare('kvitka', [
        TargetModule,
        clientModule('kvitka', [forged(entry)]),
      ]);

      const error = await prepared.app.init().then(
        () => undefined,
        (caught: unknown) => caught as Error,
      );

      expect(error?.message).toMatch(/^Client hook activation failed for client "kvitka"/);
      const everything = `${error?.message}\n${JSON.stringify(prepared.lines())}`;
      for (const secret of secretPattern.split('|')) expect(everything).not.toContain(secret);
    });
  });
});

describe('the initialization window (documented limitation)', () => {
  @Injectable()
  class EarlyCaller implements OnModuleInit {
    early?: number;

    constructor(@Inject(Converter) private readonly converter: Converter) {}

    async onModuleInit(): Promise<void> {
      this.early = await this.converter.convert(5);
    }
  }

  @Module({ imports: [TargetModule], providers: [EarlyCaller] })
  class EarlyModule {}

  it('a call made while modules initialise runs without hooks; later calls are hooked', async () => {
    const { app, converter } = await boot('kvitka', [
      EarlyModule,
      clientModule('kvitka', [KvitkaHooks]),
    ]);
    expect(app.get(EarlyCaller, { strict: false }).early).toBe(50);
    expect(await converter.convert(5)).toBe(120);
  });
});
