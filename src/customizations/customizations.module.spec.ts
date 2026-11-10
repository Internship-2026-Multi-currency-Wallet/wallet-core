import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import type { DynamicModule, INestApplication, Provider, Type } from '@nestjs/common';
import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import 'reflect-metadata';
import { AppConfig } from '../config/app-config.js';
import type { ClientCode } from '../config/env.schema.js';
import { httpLoggerOptions } from '../logging/logger.options.js';
import { ClientHookActivator } from './client-hook-activator.js';
import { ClientHook } from './client-hook.decorator.js';
import { DemoModule } from './clients/demo/demo.module.js';
import { KvitkaModule } from './clients/kvitka/kvitka.module.js';
import { WislaModule } from './clients/wisla/wisla.module.js';
import { Customizable } from './customizable.decorator.js';
import { CustomizationsCoreModule } from './customizations-core.module.js';
import { CustomizationsModule } from './customizations.module.js';
import { HookRegistry } from './hook-registry.js';
import type { ArgsReplacement, ResultReplacement } from './hook-runner.js';
import type { AfterHook, BeforeHook } from './hook.types.js';

/**
 * Integration tests of the PRODUCTION wiring: the real `CustomizationsModule` with the real
 * `KvitkaModule`, `WislaModule` and `DemoModule`, booted as a Nest application once per `CLIENT`.
 * The production client modules declare no hooks, so each test adds test-only hook providers to
 * them (see `withProviders`); a fake service stands in for the core service they hook.
 */

/* -------------------------------------------------------------------------------------------- *
 * Test-only fixtures: a core service and one set of hooks per client. Outcomes differ per client.
 * -------------------------------------------------------------------------------------------- */

@Injectable()
class CallLog {
  readonly entries: string[] = [];
  readonly constructed: string[] = [];
}

/** Stand-in for a core service: `convert(5)` is 50 without any client hook. */
@Injectable()
class Converter {
  constructor(@Inject(CallLog) private readonly log: CallLog) {}

  @Customizable()
  convert(amount: number): Promise<number> {
    this.log.entries.push(`core:${amount}`);
    return Promise.resolve(amount * 10);
  }
}

@Module({ providers: [Converter], exports: [Converter] })
class ConverterModule {}

// convert(5): kvitka (5+1)*10*2 = 120, wisla (5*2)*10+1 = 101, demo (5+100)*10+1000 = 2050.
@Injectable()
class KvitkaTestHooks {
  constructor(@Inject(CallLog) private readonly log: CallLog) {
    log.constructed.push('kvitka');
  }

  @ClientHook('kvitka', Converter, 'convert', 'before')
  bump({ args }: BeforeHook<Converter, 'convert'>): ArgsReplacement<[amount: number]> {
    this.log.entries.push('kvitka:before');
    return { args: [args[0] + 1] };
  }

  @ClientHook('kvitka', Converter, 'convert', 'after')
  double({ result }: AfterHook<Converter, 'convert'>): ResultReplacement<number> {
    this.log.entries.push('kvitka:after');
    return { result: result * 2 };
  }
}

@Injectable()
class WislaTestHooks {
  constructor(@Inject(CallLog) private readonly log: CallLog) {
    log.constructed.push('wisla');
  }

  @ClientHook('wisla', Converter, 'convert', 'before')
  twice({ args }: BeforeHook<Converter, 'convert'>): ArgsReplacement<[amount: number]> {
    this.log.entries.push('wisla:before');
    return { args: [args[0] * 2] };
  }

  @ClientHook('wisla', Converter, 'convert', 'after')
  plusOne({ result }: AfterHook<Converter, 'convert'>): ResultReplacement<number> {
    this.log.entries.push('wisla:after');
    return { result: result + 1 };
  }
}

@Injectable()
class DemoTestHooks {
  constructor(@Inject(CallLog) private readonly log: CallLog) {
    log.constructed.push('demo');
  }

  @ClientHook('demo', Converter, 'convert', 'before')
  plusHundred({ args }: BeforeHook<Converter, 'convert'>): ArgsReplacement<[amount: number]> {
    this.log.entries.push('demo:before');
    return { args: [args[0] + 100] };
  }

  @ClientHook('demo', Converter, 'convert', 'after')
  plusThousand({ result }: AfterHook<Converter, 'convert'>): ResultReplacement<number> {
    this.log.entries.push('demo:after');
    return { result: result + 1000 };
  }
}

/* -------------------------------------------------------------------------------------------- *
 * Harness.
 * -------------------------------------------------------------------------------------------- */

/**
 * Adds providers to a module's metadata for the duration of ONE test (undone in `afterEach`).
 * Production client modules list no hook providers, and a hook provider has to be declared in the
 * module that subscribes, so this is how a test puts its fixtures into the real modules.
 */
const undo: (() => void)[] = [];
function withProviders(module: Type, providers: Provider[]): void {
  const original = Reflect.getOwnMetadata(MODULE_METADATA.PROVIDERS, module) as
    Provider[] | undefined;
  Reflect.defineMetadata(MODULE_METADATA.PROVIDERS, [...(original ?? []), ...providers], module);
  undo.push(() => {
    if (original === undefined) Reflect.deleteMetadata(MODULE_METADATA.PROVIDERS, module);
    else Reflect.defineMetadata(MODULE_METADATA.PROVIDERS, original, module);
  });
}

/** Every client's test hooks, each in ITS OWN client module, like real hooks would be. */
function ownHooksInEachModule(): void {
  withProviders(KvitkaModule, [KvitkaTestHooks]);
  withProviders(WislaModule, [WislaTestHooks]);
  withProviders(DemoModule, [DemoTestHooks]);
}

@Global()
@Module({})
class SupportModule {}

// nestjs-pino keeps one logger per process (the first application creates it), so every application
// of this file shares one sink; each test reads the lines written since it started.
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
  jest.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const restore of undo.splice(0).reverse()) restore();
});

async function prepare(client: ClientCode) {
  const startAt = written.length;
  const support: DynamicModule = {
    module: SupportModule,
    global: true,
    providers: [
      {
        provide: AppConfig,
        useValue: AppConfig.fromEnv({ CLIENT: client, LOG_LEVEL: 'info', NODE_ENV: 'test' }),
      },
      CallLog,
    ],
    exports: [AppConfig, CallLog],
  };
  const moduleRef = await Test.createTestingModule({
    imports: [
      support,
      LoggerModule.forRoot({ pinoHttp: [httpLoggerOptions(LOGGER_SETTINGS), sink] }),
      ConverterModule,
      CustomizationsModule,
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  apps.push(app);
  return {
    app,
    moduleRef,
    lines: () => written.slice(startAt).map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

async function boot(client: ClientCode) {
  const prepared = await prepare(client);
  await prepared.app.init();
  const { app, moduleRef, lines } = prepared;
  return {
    app,
    lines,
    log: app.get(CallLog),
    registry: app.get(HookRegistry, { strict: false }),
    converter: moduleRef.get(Converter, { strict: false }),
  };
}

const CLIENT_MODULES = { kvitka: KvitkaModule, wisla: WislaModule, demo: DemoModule } as const;

/* -------------------------------------------------------------------------------------------- */

describe('module wiring', () => {
  const importsOf = (module: Type): unknown[] =>
    Reflect.getMetadata(MODULE_METADATA.IMPORTS, module) as unknown[];

  it('CustomizationsModule imports the engine and every client module, and nothing else', () => {
    expect(importsOf(CustomizationsModule)).toEqual([
      CustomizationsCoreModule,
      KvitkaModule,
      WislaModule,
      DemoModule,
    ]);
  });

  it.each(Object.values(CLIENT_MODULES))(
    '%p imports the engine and declares no hooks',
    (module) => {
      expect(importsOf(module)).toEqual([CustomizationsCoreModule]);
      expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, module)).toEqual([]);
    },
  );

  it('the core engine does not import any client module', () => {
    expect(importsOf(CustomizationsCoreModule)).not.toEqual(
      expect.arrayContaining(Object.values(CLIENT_MODULES)),
    );
  });
});

describe.each(['kvitka', 'wisla', 'demo'] as const)('CLIENT=%s', (client) => {
  const outcome = { kvitka: 120, wisla: 101, demo: 2050 }[client];
  const others = (['kvitka', 'wisla', 'demo'] as const).filter((other) => other !== client);

  beforeEach(ownHooksInEachModule);

  it('subscribes only its own client module', async () => {
    const subscribe = jest.spyOn(ClientHookActivator.prototype, 'subscribe');
    await boot(client);
    expect(subscribe.mock.calls).toEqual([[CLIENT_MODULES[client]]]);
  });

  it('runs its before hook, the core method and its after hook, with its own outcome', async () => {
    const { converter, log } = await boot(client);

    expect(await converter.convert(5)).toBe(outcome);

    const argument = { kvitka: 6, wisla: 10, demo: 105 }[client];
    expect(log.entries).toEqual([`${client}:before`, `core:${argument}`, `${client}:after`]);
  });

  it("never runs another client's hook, though every hook provider is constructed", async () => {
    const { converter, log } = await boot(client);
    expect([...log.constructed].sort()).toEqual(['demo', 'kvitka', 'wisla']);

    await converter.convert(5);
    await converter.convert(7);

    for (const other of others) {
      expect(log.entries.filter((entry) => entry.startsWith(`${other}:`))).toEqual([]);
    }
    expect(log.entries.filter((entry) => entry.startsWith(`${client}:`))).toHaveLength(4);
  });

  it('registers exactly the hooks of this client and reports them once', async () => {
    const { registry, lines } = await boot(client);

    const { before, after } = registry.erasedHandlersFor(Converter, 'convert');
    expect([before.length, after.length]).toEqual([1, 1]);
    expect(lines().filter((line) => line.msg === 'client hooks activated')).toEqual([
      expect.objectContaining({ hooks: 2, methods: 1 }),
    ]);
  });
});

describe.each(['kvitka', 'wisla', 'demo'] as const)(
  'CLIENT=%s with the production modules as they are',
  (client) => {
    it('the production module, which declares no hooks, starts and leaves the service unhooked', async () => {
      undo
        .splice(0)
        .reverse()
        .forEach((restore) => restore());
      const { converter, registry, lines } = await boot(client);

      expect(await converter.convert(5)).toBe(50);
      expect(registry.erasedHandlersFor(Converter, 'convert')).toEqual({ before: [], after: [] });
      expect(lines().filter((line) => line.msg === 'client hooks activated')).toEqual([
        expect.objectContaining({ hooks: 0, methods: 0 }),
      ]);
    });
  },
);

describe('a hook placed in the wrong client module', () => {
  it('stays inactive when its client is not configured (the module does not subscribe)', async () => {
    withProviders(WislaModule, [KvitkaTestHooks]);
    const { converter, log } = await boot('kvitka');

    expect(await converter.convert(5)).toBe(50);
    expect(log.constructed).toEqual(['kvitka']);
    expect(log.entries).toEqual(['core:5']);
  });

  it('is refused at startup when the module of the configured client holds it', async () => {
    withProviders(WislaModule, [KvitkaTestHooks]);
    const { app } = await prepare('wisla');

    await expect(app.init()).rejects.toThrow(
      /belongs to client "kvitka", but the active client is "wisla"/,
    );
  });
});
