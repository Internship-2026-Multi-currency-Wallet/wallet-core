import { jest } from '@jest/globals';
import 'reflect-metadata';
import { CLIENT_HOOK_KEY, ClientHook, type ClientHookMetadata } from './client-hook.decorator.js';
import {
  type CheckedHookRegistration,
  type HookCheck,
  type HookProblem,
  checkClientHook,
  isCheckedHookRegistration,
} from './checked-hook.js';
import { Customizable } from './customizable.decorator.js';
import { HookRegistry } from './hook-registry.js';
import { runWithHooks } from './hook-runner.js';
import type { AfterHook, BeforeHook } from './hook.types.js';

/** Everything a fixture does is recorded here, so a test can prove that nothing ran. */
const calls: string[] = [];
beforeEach(() => {
  calls.length = 0;
});

/** Test fixtures; nothing to do with a real service. */
class Calculator {
  @Customizable()
  multiply(a: number, b: number): Promise<number> {
    calls.push('core:multiply');
    return Promise.resolve(a * b);
  }

  @Customizable({ propagateExceptions: true })
  add(a: number, b: number): Promise<number> {
    calls.push('core:add');
    return Promise.resolve(a + b);
  }

  /** An async method WITHOUT `@Customizable()`. */
  plain(): Promise<void> {
    calls.push('core:plain');
    return Promise.resolve();
  }

  /** An accessor: the getter must never be called by the checker. */
  get fast(): Promise<number> {
    calls.push('core:getter');
    return Promise.resolve(1);
  }
}
// A data property on the prototype that is not a function.
Object.defineProperty(Calculator.prototype, 'constant', { value: 5 });

/** Inherits everything, declares nothing. */
class InheritingCalculator extends Calculator {}

/** Declares its own, decorated `multiply`. */
class OverridingCalculator extends Calculator {
  @Customizable()
  override multiply(a: number, b: number): Promise<number> {
    return Promise.resolve(a * b + 1);
  }
}

/** A client module's provider: real `@ClientHook` use, handlers that record when they run. */
class KvitkaHooks {
  readonly factor = 2;

  @ClientHook('kvitka', Calculator, 'multiply', 'before')
  first(_hook: BeforeHook<Calculator, 'multiply'>): void {
    calls.push('hook:first');
  }

  @ClientHook('kvitka', Calculator, 'multiply', 'before')
  second(_hook: BeforeHook<Calculator, 'multiply'>): void {
    calls.push('hook:second');
  }

  @ClientHook('kvitka', Calculator, 'multiply', 'after')
  double({ result }: AfterHook<Calculator, 'multiply'>): { result: number } {
    calls.push('hook:double');
    return { result: result * this.factor };
  }

  @ClientHook('wisla', Calculator, 'multiply', 'after')
  forWisla(_hook: AfterHook<Calculator, 'multiply'>): void {
    calls.push('hook:wisla');
  }
}

/** The `@ClientHook` entries the decorator stored on a handler (what a scanner will read). */
function entriesOf(handler: unknown): ClientHookMetadata[] {
  return Reflect.getOwnMetadata(CLIENT_HOOK_KEY, handler as object) as ClientHookMetadata[];
}

const kvitka = new KvitkaHooks();
const doubleEntry = entriesOf(KvitkaHooks.prototype.double)[0];

/** A hook function whose own metadata is exactly `entry`, so only what a test changes can fail. */
function handlerCarrying(entry: unknown): () => void {
  const handler = function forged(): void {
    calls.push('hook:forged');
  };
  Reflect.defineMetadata(CLIENT_HOOK_KEY, [entry], handler);
  return handler;
}

/** Checks `entry` against a handler that carries it. Untyped on purpose: this is the erased side. */
function check(entry: unknown, expectedClient?: 'demo' | 'kvitka' | 'wisla'): HookCheck {
  return checkClientHook(entry, handlerCarrying(entry), {}, expectedClient);
}

const valid = { client: 'kvitka', target: Calculator, method: 'multiply', phase: 'after' };

function accepted(result: HookCheck): CheckedHookRegistration {
  if (!result.ok) throw new Error(`expected a pass: ${JSON.stringify(result.problems)}`);
  return result.registration;
}

function rejected(result: HookCheck): readonly HookProblem[] {
  if (result.ok) throw new Error('expected the check to fail');
  return result.problems;
}

const codes = (result: HookCheck): string[] => rejected(result).map((problem) => problem.code);

describe('checkClientHook', () => {
  describe('valid metadata', () => {
    it('accepts a real @ClientHook before entry', () => {
      const entry = entriesOf(KvitkaHooks.prototype.first)[0];
      const registration = accepted(checkClientHook(entry, KvitkaHooks.prototype.first, kvitka));
      expect(registration).toMatchObject({
        client: 'kvitka',
        target: Calculator,
        method: 'multiply',
        phase: 'before',
      });
    });

    it('accepts a real @ClientHook after entry', () => {
      const registration = accepted(
        checkClientHook(doubleEntry, KvitkaHooks.prototype.double, kvitka),
      );
      expect(registration).toMatchObject({ client: 'kvitka', method: 'multiply', phase: 'after' });
    });

    it('accepts every known client, phase and customizable method of the fixtures', () => {
      for (const client of ['demo', 'kvitka', 'wisla']) {
        for (const phase of ['before', 'after']) {
          for (const method of ['multiply', 'add']) {
            expect(check({ ...valid, client, phase, method }).ok).toBe(true);
          }
        }
      }
    });

    it('accepts a method that a subclass declares itself and decorates again', () => {
      expect(check({ ...valid, target: OverridingCalculator }).ok).toBe(true);
    });

    it('binds the handler to the provider instance', async () => {
      const registration = accepted(
        checkClientHook(doubleEntry, KvitkaHooks.prototype.double, kvitka),
      );
      expect(registration.handler).not.toBe(KvitkaHooks.prototype.double);
      const registry = new HookRegistry();
      registry.registerChecked(registration);
      const { before, after } = registry.erasedHandlersFor(Calculator, 'multiply');
      const result = await runWithHooks({
        method: (...args: unknown[]): Promise<unknown> => Promise.resolve(Number(args[0]) + 1),
        thisArg: undefined,
        args: [4],
        before,
        after,
        propagateExceptions: true,
        onHandlerError: () => undefined,
      });
      expect(result).toBe(10); // (4 + 1) * `this.factor`; `this` was the instance
    });

    it('returns a frozen registration holding captured values', () => {
      const registration = accepted(check({ ...valid }));
      expect(Object.isFrozen(registration)).toBe(true);
      expect(isCheckedHookRegistration(registration)).toBe(true);
    });
  });

  describe('rejects with an actionable problem', () => {
    it('unknown client', () => {
      const result = check({ ...valid, client: 'nope' });
      expect(codes(result)).toEqual(['unknown-client']);
      expect(rejected(result)[0].message).toBe(
        'forged -> Calculator.multiply (?, after): unknown client; known: demo, kvitka, wisla',
      );
    });

    it.each([undefined, null, 5, 'Kvitka', {}])('unknown client value %p', (client) => {
      expect(codes(check({ ...valid, client }))).toEqual(['unknown-client']);
    });

    it('unknown phase', () => {
      const result = check({ ...valid, phase: 'around' });
      expect(codes(result)).toEqual(['unknown-phase']);
      expect(rejected(result)[0].message).toBe(
        'forged -> Calculator.multiply (kvitka, ?): unknown phase; known: before, after',
      );
    });

    it.each([undefined, null, 1, 'AFTER'])('unknown phase value %p', (phase) => {
      expect(codes(check({ ...valid, phase }))).toEqual(['unknown-phase']);
    });

    it.each([
      ['missing', undefined],
      ['null', null],
      ['a plain object', { name: 'Calculator' }],
      ['a string', 'Calculator'],
      ['an arrow function (no prototype)', () => undefined],
      ['an instance instead of the class', new Calculator()],
    ])('invalid target: %s', (_name, target) => {
      const problems = codes(check({ ...valid, target }));
      expect(problems).toEqual(['invalid-target']);
    });

    it('missing method', () => {
      const result = check({ ...valid, method: 'nope' });
      expect(codes(result)).toEqual(['method-not-found']);
      expect(rejected(result)[0].message).toContain(
        'Calculator does not declare the hooked method itself',
      );
      expect(rejected(result)[0].message).not.toContain('nope');
    });

    it('never repeats a value taken from the metadata, however much it looks like an identifier', () => {
      const secrets = ['sk_live_AbC123xyz789', 'tok_Zq81LmN0pQ', 'pw_hunter2_Rt5', 'key_77Hh0aBcD'];
      const result = check({
        client: secrets[0],
        target: secrets[1],
        method: secrets[2],
        phase: secrets[3],
      });
      const text = rejected(result)
        .map((problem) => problem.message)
        .join('\n');
      for (const secret of secrets) expect(text).not.toContain(secret);
      expect(codes(result)).toEqual(
        expect.arrayContaining(['unknown-client', 'unknown-phase', 'invalid-target']),
      );
    });

    it('names a method only when the target really declares it', () => {
      expect(rejected(check({ ...valid, client: 'nope' }))[0].message).toContain(
        'Calculator.multiply (',
      );
      expect(rejected(check({ ...valid, method: 'sk_live_AbC123xyz789' }))[0].message).toContain(
        'Calculator.? (',
      );
    });

    it.each([
      ['an empty string', ''],
      ['undefined', undefined],
      ['a number', 1],
      ['a symbol', Symbol('m')],
    ])('invalid method name: %s', (_name, method) => {
      expect(codes(check({ ...valid, method }))).toEqual(['invalid-method-name']);
    });

    it('a method property that is not a function', () => {
      expect(codes(check({ ...valid, method: 'constant' }))).toEqual(['method-not-function']);
    });

    it('an accessor, without calling the getter', () => {
      expect(codes(check({ ...valid, method: 'fast' }))).toEqual(['method-is-accessor']);
      expect(calls).toEqual([]);
    });

    it('a method without @Customizable()', () => {
      const result = check({ ...valid, method: 'plain' });
      expect(codes(result)).toEqual(['not-customizable']);
      expect(rejected(result)[0].message).toContain('"plain" is not marked @Customizable()');
    });

    it('a subclass that only inherits the method: exact declaring-class matching', () => {
      const result = check({ ...valid, target: InheritingCalculator });
      expect(codes(result)).toEqual(['method-not-found']);
      expect(rejected(result)[0].message).toContain('hook the class that declares it');
    });

    it('a member of Object.prototype is not a method of the target', () => {
      expect(codes(check({ ...valid, method: 'toString' }))).toEqual(['method-not-found']);
      expect(codes(check({ ...valid, method: 'constructor' }))).toEqual(['not-customizable']);
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['an object', {}],
      ['a string', 'multiply'],
    ])('a handler that is not a function: %s', (_name, handler) => {
      expect(codes(checkClientHook(valid, handler, {}))).toEqual(['invalid-handler']);
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a string', 'x'],
    ])('a provider instance that is not an object: %s', (_name, instance) => {
      const result = checkClientHook(valid, handlerCarrying(valid), instance);
      expect(codes(result)).toEqual(['invalid-instance']);
    });

    it('reports every problem at once, in a fixed order', () => {
      const entry = { client: 'x', target: undefined, method: '', phase: 'y' };
      expect(codes(checkClientHook(entry, undefined, null))).toEqual([
        'unknown-client',
        'unknown-phase',
        'invalid-target',
        'invalid-method-name',
        'invalid-handler',
        'invalid-instance',
      ]);
    });
  });

  describe('client identity', () => {
    it('accepts the entry when it belongs to the expected (active) client', () => {
      expect(check({ ...valid }, 'kvitka').ok).toBe(true);
    });

    it('rejects an entry of another client when a client is expected', () => {
      const result = check({ ...valid, client: 'wisla' }, 'kvitka');
      expect(codes(result)).toEqual(['client-mismatch']);
      expect(rejected(result)[0].message).toBe(
        'forged -> Calculator.multiply (wisla, after): belongs to client "wisla", but the active client is "kvitka"',
      );
    });

    it('validates an INACTIVE client statically when no client is expected', () => {
      // Valid for wisla, and it stays valid; only an expected client turns it into a mismatch.
      const wisla = entriesOf(KvitkaHooks.prototype.forWisla)[0];
      expect(checkClientHook(wisla, KvitkaHooks.prototype.forWisla, kvitka).ok).toBe(true);
      expect(check({ ...valid, client: 'wisla' }).ok).toBe(true);
    });

    it('still reports an unknown client (not a mismatch) when a client is expected', () => {
      expect(codes(check({ ...valid, client: 'nope' }, 'kvitka'))).toEqual(['unknown-client']);
    });
  });

  describe('forged or inconsistent metadata', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a string', 'x'],
      ['a number', 1],
    ])('metadata that is not an object: %s', (_name, entry) => {
      expect(codes(checkClientHook(entry, handlerCarrying(entry), {}))).toEqual([
        'invalid-metadata',
      ]);
    });

    it('metadata with a throwing getter is a problem, not an exception', () => {
      const entry = {};
      Object.defineProperty(entry, 'client', {
        get() {
          throw new Error('boom');
        },
      });
      expect(codes(checkClientHook(entry, handlerCarrying(entry), {}))).toEqual([
        'invalid-metadata',
      ]);
    });

    it('reads each metadata field exactly once', () => {
      let reads = 0;
      const entry = {
        get client() {
          reads += 1;
          return 'kvitka';
        },
        target: Calculator,
        method: 'multiply',
        phase: 'after',
      };
      // The handler's own entry is a separate plain object, so only the checked one is counted.
      const handler = handlerCarrying({ ...valid });
      accepted(checkClientHook(entry, handler, {}));
      expect(reads).toBe(1);
    });

    it('a handler that carries no @ClientHook metadata', () => {
      const result = checkClientHook(valid, () => undefined, {});
      expect(codes(result)).toEqual(['metadata-mismatch']);
    });

    it('a handler whose metadata is not a list of entries', () => {
      const handler = (): void => undefined;
      Reflect.defineMetadata(CLIENT_HOOK_KEY, valid, handler);
      expect(codes(checkClientHook(valid, handler, {}))).toEqual(['metadata-mismatch']);
    });

    it.each([
      ['client', { client: 'demo' }],
      ['target', { target: OverridingCalculator }],
      ['method', { method: 'add' }],
      ['phase', { phase: 'before' }],
    ])("an entry that differs from the handler's own metadata in %s", (_field, change) => {
      const result = checkClientHook({ ...valid, ...change }, handlerCarrying(valid), {});
      expect(codes(result)).toEqual(['metadata-mismatch']);
    });

    it('accepts an entry that is any one of several stacked on the handler', () => {
      const handler = handlerCarrying(valid);
      Reflect.defineMetadata(CLIENT_HOOK_KEY, [{ ...valid, phase: 'before' }, valid], handler);
      expect(checkClientHook(valid, handler, {}).ok).toBe(true);
    });

    it('does not put object contents or long strings into messages', () => {
      const result = check({
        client: { token: 'secret-token' },
        target: { amount: 123456 },
        method: 'm'.repeat(200),
        phase: ['secret-phase'],
      });
      const text = rejected(result)
        .map((problem) => problem.message)
        .join('\n');
      expect(text).not.toContain('secret');
      expect(text).not.toContain('123456');
      expect(text).not.toContain('m'.repeat(41));
      expect(codes(result)).toEqual(['unknown-client', 'unknown-phase', 'invalid-target']);
    });
  });

  describe('untrusted arrays and functions', () => {
    const boom = (): never => {
      throw new Error('boom');
    };

    /** A handler whose own metadata is the given list (any value), plus the entry to check. */
    function withMetadata(list: unknown): () => void {
      const handler = (): void => {
        calls.push('hook:forged');
      };
      Reflect.defineMetadata(CLIENT_HOOK_KEY, list, handler);
      return handler;
    }

    it("does not call the metadata list's own .some() or iterator; a readable match still counts", () => {
      const list: unknown[] = [{ ...valid }];
      Object.defineProperty(list, 'some', { value: 123 });
      Object.defineProperty(list, Symbol.iterator, { get: boom });
      expect(checkClientHook(valid, withMetadata(list), {}).ok).toBe(true);
      expect(calls).toEqual([]);
    });

    it('a list with a replaced .some() and no matching entry is a mismatch', () => {
      const list: unknown[] = [{ ...valid, phase: 'before' }];
      Object.defineProperty(list, 'some', { value: 123 });
      expect(codes(checkClientHook(valid, withMetadata(list), {}))).toEqual(['metadata-mismatch']);
    });

    it('a list element that is a throwing accessor is a mismatch, not an exception', () => {
      const list: unknown[] = [{ ...valid }];
      Object.defineProperty(list, 0, { get: boom });
      expect(codes(checkClientHook(valid, withMetadata(list), {}))).toEqual(['metadata-mismatch']);
    });

    it('a list that is a proxy with a throwing trap is a mismatch', () => {
      const list = new Proxy([{ ...valid }], { get: boom });
      expect(codes(checkClientHook(valid, withMetadata(list), {}))).toEqual(['metadata-mismatch']);
    });

    it('keeps the other problems when the metadata list is malformed', () => {
      const list: unknown[] = [];
      Object.defineProperty(list, 0, { get: boom });
      const entry = { ...valid, client: 'nope' };
      expect(codes(checkClientHook(entry, withMetadata(list), null))).toEqual([
        'unknown-client',
        'metadata-mismatch',
        'invalid-instance',
      ]);
    });

    it('a target whose name getter throws still validates, and is named by a fallback', () => {
      class HostileName {
        @Customizable()
        multiply(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      Object.defineProperty(HostileName, 'name', { get: boom });
      expect(check({ ...valid, target: HostileName }).ok).toBe(true);

      const result = check({ ...valid, target: HostileName, method: 'nope' });
      expect(codes(result)).toEqual(['method-not-found']);
      expect(rejected(result)[0].message).toContain(
        '(anonymous class) does not declare the hooked method itself',
      );
    });

    it('a handler whose name getter throws is rejected as unbindable, with a fallback name', () => {
      const handler = handlerCarrying(valid);
      Object.defineProperty(handler, 'name', { get: boom });
      const result = checkClientHook(valid, handler, {});
      expect(codes(result)).toEqual(['invalid-handler']);
      expect(rejected(result)[0].message).toMatch(/^\(unnamed handler\) -> Calculator\.multiply/);
    });

    it('a handler whose length getter throws is rejected as unbindable', () => {
      const handler = handlerCarrying(valid);
      Object.defineProperty(handler, 'length', { get: boom });
      expect(codes(checkClientHook(valid, handler, {}))).toEqual(['invalid-handler']);
    });

    it('does not try to bind a handler while other problems are being reported', () => {
      const entry = { ...valid, client: 'nope' };
      const handler = handlerCarrying(entry);
      Object.defineProperty(handler, 'length', { get: boom });
      expect(codes(checkClientHook(entry, handler, {}))).toEqual(['unknown-client']);
    });
  });

  describe('purity', () => {
    it('runs no hook, no core method and no getter, passing or failing', () => {
      accepted(checkClientHook(doubleEntry, KvitkaHooks.prototype.double, kvitka));
      check({ ...valid, method: 'fast' });
      check({ ...valid, method: 'plain' });
      check({ ...valid, client: 'nope' });
      expect(calls).toEqual([]);
    });

    it('registering a checked hook runs nothing either', () => {
      const registry = new HookRegistry();
      registry.registerChecked(
        accepted(checkClientHook(doubleEntry, KvitkaHooks.prototype.double, kvitka)),
      );
      registry.handlersFor(Calculator, 'multiply', 'after');
      registry.erasedHandlersFor(Calculator, 'multiply');
      expect(calls).toEqual([]);
    });

    it('later changes to the metadata object cannot change what was registered', () => {
      const entry: Record<string, unknown> = { ...valid };
      const handler = handlerCarrying({ ...valid });
      const registration = accepted(checkClientHook(entry, handler, {}));

      entry.target = OverridingCalculator;
      entry.method = 'add';
      entry.phase = 'before';
      entry.client = 'wisla';

      expect(registration).toMatchObject({
        client: 'kvitka',
        target: Calculator,
        method: 'multiply',
        phase: 'after',
      });
      const registry = new HookRegistry();
      registry.registerChecked(registration);
      expect(registry.erasedHandlersFor(Calculator, 'multiply').after).toHaveLength(1);
      expect(registry.erasedHandlersFor(OverridingCalculator, 'add').before).toHaveLength(0);
    });

    it("later replacement of the handler function's metadata cannot change a registration", () => {
      const handler = handlerCarrying(valid);
      const registration = accepted(checkClientHook(valid, handler, {}));
      Reflect.defineMetadata(CLIENT_HOOK_KEY, [], handler);
      expect(registration.method).toBe('multiply');
      expect(registration.handler).toEqual(expect.any(Function));
    });
  });
});

describe('HookRegistry.registerChecked', () => {
  /** All four real hooks of the fixture provider, checked. */
  function registrationsOf(): Record<
    'first' | 'second' | 'double' | 'forWisla',
    CheckedHookRegistration
  > {
    const make = (name: 'first' | 'second' | 'double' | 'forWisla'): CheckedHookRegistration =>
      accepted(
        checkClientHook(
          entriesOf(KvitkaHooks.prototype[name])[0],
          KvitkaHooks.prototype[name],
          kvitka,
        ),
      );
    return {
      first: make('first'),
      second: make('second'),
      double: make('double'),
      forWisla: make('forWisla'),
    };
  }

  it('round trip: a checked hook comes back from handlersFor, by identity', () => {
    const registry = new HookRegistry();
    const { double } = registrationsOf();
    registry.registerChecked(double);
    const stored = registry.handlersFor(Calculator, 'multiply', 'after');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toBe(double.handler);
  });

  it('keeps registration order and separates before from after', () => {
    const registry = new HookRegistry();
    const r = registrationsOf();
    registry.registerChecked(r.first);
    registry.registerChecked(r.double);
    registry.registerChecked(r.second);
    expect(registry.handlersFor(Calculator, 'multiply', 'before')).toEqual([
      r.first.handler,
      r.second.handler,
    ]);
    expect(registry.handlersFor(Calculator, 'multiply', 'after')).toEqual([r.double.handler]);
  });

  it('shares storage and order with the typed register()', () => {
    const registry = new HookRegistry();
    const r = registrationsOf();
    const typed = jest.fn(() => undefined);
    registry.registerChecked(r.first);
    registry.register(Calculator, 'multiply', 'before', typed);
    registry.registerChecked(r.second);
    expect(registry.handlersFor(Calculator, 'multiply', 'before')).toEqual([
      r.first.handler,
      typed,
      r.second.handler,
    ]);
  });

  it('does not de-duplicate, like register()', () => {
    const registry = new HookRegistry();
    const { first } = registrationsOf();
    registry.registerChecked(first);
    registry.registerChecked(first);
    expect(registry.handlersFor(Calculator, 'multiply', 'before')).toHaveLength(2);
  });

  it("matches the exact class: a subclass does not see the base class's hooks", () => {
    const registry = new HookRegistry();
    registry.registerChecked(registrationsOf().first);
    expect(registry.handlersFor(InheritingCalculator, 'multiply', 'before')).toEqual([]);
    expect(registry.erasedHandlersFor(InheritingCalculator, 'multiply').before).toEqual([]);
  });

  it('hands out frozen snapshots that later registrations do not change', () => {
    const registry = new HookRegistry();
    const r = registrationsOf();
    registry.registerChecked(r.first);
    const typedSnapshot = registry.handlersFor(Calculator, 'multiply', 'before');
    const erasedSnapshot = registry.erasedHandlersFor(Calculator, 'multiply');
    registry.registerChecked(r.second);

    expect(typedSnapshot).toEqual([r.first.handler]);
    expect(erasedSnapshot.before).toEqual([r.first.handler]);
    expect(Object.isFrozen(typedSnapshot)).toBe(true);
    expect(Object.isFrozen(erasedSnapshot)).toBe(true);
    expect(Object.isFrozen(erasedSnapshot.before)).toBe(true);
    expect(Object.isFrozen(registry.erasedHandlersFor(Calculator, 'multiply').after)).toBe(true);
    expect(registry.erasedHandlersFor(Calculator, 'multiply').before).toHaveLength(2);
  });

  it('keeps separate registries isolated', () => {
    const one = new HookRegistry();
    const two = new HookRegistry();
    one.registerChecked(registrationsOf().first);
    expect(one.erasedHandlersFor(Calculator, 'multiply').before).toHaveLength(1);
    expect(two.erasedHandlersFor(Calculator, 'multiply').before).toHaveLength(0);
  });

  it('returns the same frozen empty lists for an unknown method or class', () => {
    const registry = new HookRegistry();
    const none = registry.erasedHandlersFor(Calculator, 'unknown');
    expect(none.before).toEqual([]);
    expect(none.after).toEqual([]);
    expect(Object.isFrozen(none)).toBe(true);
  });

  it('rejects, at runtime, anything the checker did not make', () => {
    const registry = new HookRegistry();
    const real = registrationsOf().first;
    const forged = [
      { ...real }, // a copy of a real one
      {
        client: 'kvitka',
        target: Calculator,
        method: 'multiply',
        phase: 'before',
        handler: () => 1,
      },
      Object.create(real) as object,
      null,
      undefined,
      'x',
    ];
    for (const value of forged) {
      expect(() => registry.registerChecked(value as unknown as CheckedHookRegistration)).toThrow(
        'registerChecked() only accepts the result of checkClientHook()',
      );
    }
    expect(registry.erasedHandlersFor(Calculator, 'multiply').before).toEqual([]);
  });

  it('feeds runWithHooks directly: hooks run in order around the method', async () => {
    const registry = new HookRegistry();
    const r = registrationsOf();
    registry.registerChecked(r.first);
    registry.registerChecked(r.second);
    registry.registerChecked(r.double);
    const { before, after } = registry.erasedHandlersFor(Calculator, 'multiply');
    const result = await runWithHooks({
      method: (...args: unknown[]): Promise<unknown> => Promise.resolve(Number(args[0]) * 3),
      thisArg: undefined,
      args: [5],
      before,
      after,
      propagateExceptions: true,
      onHandlerError: () => undefined,
    });
    expect(result).toBe(30);
    expect(calls).toEqual(['hook:first', 'hook:second', 'hook:double']);
  });

  /** Compile-time only: the function is never called. `npm run typecheck` is what enforces it. */
  function unchecked(registry: HookRegistry): void {
    const literal = {
      client: 'kvitka' as const,
      target: Calculator,
      method: 'multiply',
      phase: 'after' as const,
      handler: () => undefined,
    };
    // @ts-expect-error - a plain object is not a CheckedHookRegistration; only checkClientHook makes one
    registry.registerChecked(literal);
    // @ts-expect-error - neither is the metadata entry itself
    registry.registerChecked(entriesOf(KvitkaHooks.prototype.double)[0]);
    // @ts-expect-error - nor nothing at all
    registry.registerChecked(undefined);
  }

  it('is protected at compile time (see the directives above)', () => {
    expect(typeof unchecked).toBe('function');
  });
});
