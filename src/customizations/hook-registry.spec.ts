import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { HookRegistry, type RegisteredHandler } from './hook-registry.js';
import { type AfterHandler, type BeforeHandler, runWithHooks } from './hook-runner.js';
import type { HookPhase, MethodArgs, MethodResult } from './hook.types.js';

type Args = [a: number, b: number];

/** Test fixtures; nothing to do with a real service. */
class Calculator {
  multiply(a: number, b: number): Promise<number> {
    return Promise.resolve(a * b);
  }

  add(a: number, b: number): Promise<number> {
    return Promise.resolve(a + b);
  }

  label(): string {
    return 'sync';
  }

  // Only here so the type tests can show that private methods are not accepted.
  private secret(): Promise<void> {
    return Promise.resolve();
  }
}

class Other {
  multiply(a: number, b: number): Promise<number> {
    return Promise.resolve(a * b);
  }
}

const before = (): BeforeHandler<Args> => () => undefined;
const after = (): AfterHandler<Args, number> => () => undefined;

describe('HookRegistry', () => {
  it('returns no handlers when nothing is registered', () => {
    const registry = new HookRegistry();
    expect(registry.handlersFor(Calculator, 'multiply', 'before')).toEqual([]);
    expect(registry.handlersFor(Calculator, 'multiply', 'after')).toEqual([]);
  });

  it('registers and returns a before handler', () => {
    const registry = new HookRegistry();
    const handler = before();
    registry.register(Calculator, 'multiply', 'before', handler);
    expect(registry.handlersFor(Calculator, 'multiply', 'before')).toEqual([handler]);
    expect(registry.handlersFor(Calculator, 'multiply', 'before')[0]).toBe(handler);
    expect(registry.handlersFor(Calculator, 'multiply', 'after')).toEqual([]); // other phase
  });

  it('registers and returns an after handler', () => {
    const registry = new HookRegistry();
    const handler = after();
    registry.register(Calculator, 'multiply', 'after', handler);
    expect(registry.handlersFor(Calculator, 'multiply', 'after')[0]).toBe(handler);
    expect(registry.handlersFor(Calculator, 'multiply', 'before')).toEqual([]); // other phase
  });

  it('keeps registration order, per phase', () => {
    const registry = new HookRegistry();
    const [b1, b2, b3] = [before(), before(), before()];
    const [a1, a2] = [after(), after()];
    registry.register(Calculator, 'multiply', 'before', b1);
    registry.register(Calculator, 'multiply', 'after', a1);
    registry.register(Calculator, 'multiply', 'before', b2);
    registry.register(Calculator, 'multiply', 'after', a2);
    registry.register(Calculator, 'multiply', 'before', b3);
    expect(registry.handlersFor(Calculator, 'multiply', 'before')).toEqual([b1, b2, b3]);
    expect(registry.handlersFor(Calculator, 'multiply', 'after')).toEqual([a1, a2]);
  });

  it('keeps the same function twice if it is registered twice (no de-duplication)', () => {
    const registry = new HookRegistry();
    const handler = before();
    registry.register(Calculator, 'multiply', 'before', handler);
    registry.register(Calculator, 'multiply', 'before', handler);
    expect(registry.handlersFor(Calculator, 'multiply', 'before')).toEqual([handler, handler]);
  });

  describe('isolation', () => {
    it('keeps different methods of one class apart', () => {
      const registry = new HookRegistry();
      const [forMultiply, forAdd] = [before(), before()];
      registry.register(Calculator, 'multiply', 'before', forMultiply);
      registry.register(Calculator, 'add', 'before', forAdd);
      expect(registry.handlersFor(Calculator, 'multiply', 'before')).toEqual([forMultiply]);
      expect(registry.handlersFor(Calculator, 'add', 'before')).toEqual([forAdd]);
    });

    it('keeps different classes apart, even with the same method name', () => {
      const registry = new HookRegistry();
      const [forCalculator, forOther] = [before(), before()];
      registry.register(Calculator, 'multiply', 'before', forCalculator);
      registry.register(Other, 'multiply', 'before', forOther);
      expect(registry.handlersFor(Calculator, 'multiply', 'before')).toEqual([forCalculator]);
      expect(registry.handlersFor(Other, 'multiply', 'before')).toEqual([forOther]);
    });

    it('tells apart two different classes that have the same name', () => {
      const makeService = () =>
        class Service {
          run(): Promise<number> {
            return Promise.resolve(1);
          }
        };
      const [First, Second] = [makeService(), makeService()];
      expect(First.name).toBe(Second.name);
      expect(First).not.toBe(Second);

      const registry = new HookRegistry();
      const [forFirst, forSecond] = [jest.fn<BeforeHandler<[]>>(), jest.fn<BeforeHandler<[]>>()];
      registry.register(First, 'run', 'before', forFirst);
      registry.register(Second, 'run', 'before', forSecond);
      expect(registry.handlersFor(First, 'run', 'before')).toEqual([forFirst]);
      expect(registry.handlersFor(Second, 'run', 'before')).toEqual([forSecond]);
    });

    it('matches the exact class: a subclass does not inherit its base class handlers', () => {
      class Derived extends Calculator {}
      const registry = new HookRegistry();
      registry.register(Calculator, 'multiply', 'before', before());
      expect(registry.handlersFor(Derived, 'multiply', 'before')).toEqual([]);
    });

    it('does not share registrations between registry instances', () => {
      const [one, two] = [new HookRegistry(), new HookRegistry()];
      one.register(Calculator, 'multiply', 'before', before());
      expect(one.handlersFor(Calculator, 'multiply', 'before')).toHaveLength(1);
      expect(two.handlersFor(Calculator, 'multiply', 'before')).toEqual([]);
    });

    it('is one registry per Nest application, not a global', async () => {
      const compile = () => Test.createTestingModule({ providers: [HookRegistry] }).compile();
      const [appOne, appTwo] = [await compile(), await compile()];
      const [registryOne, registryTwo] = [appOne.get(HookRegistry), appTwo.get(HookRegistry)];

      expect(appOne.get(HookRegistry)).toBe(registryOne); // a singleton within its application
      expect(registryTwo).not.toBe(registryOne);
      registryOne.register(Calculator, 'multiply', 'before', before());
      expect(registryTwo.handlersFor(Calculator, 'multiply', 'before')).toEqual([]);
    });
  });

  describe('what is handed out', () => {
    it('cannot be used to change the registry', () => {
      const registry = new HookRegistry();
      const handler = before();
      registry.register(Calculator, 'multiply', 'before', handler);

      const list = registry.handlersFor(Calculator, 'multiply', 'before');
      expect(Object.isFrozen(list)).toBe(true);
      const mutable = list as BeforeHandler<Args>[]; // what a careless caller might do
      expect(() => mutable.push(before())).toThrow(TypeError);
      expect(() => mutable.splice(0, 1)).toThrow(TypeError);
      expect(() => (mutable[0] = before())).toThrow(TypeError);
      expect(() => (mutable.length = 0)).toThrow(TypeError);

      expect(registry.handlersFor(Calculator, 'multiply', 'before')).toEqual([handler]);
      // The empty answer is read-only too, so it cannot leak state between registries.
      const none = registry.handlersFor(Calculator, 'add', 'after') as AfterHandler<Args, number>[];
      expect(() => none.push(after())).toThrow(TypeError);
      expect(new HookRegistry().handlersFor(Calculator, 'add', 'after')).toEqual([]);
    });

    it('is a snapshot: handlers registered later do not change a list already handed out', () => {
      const registry = new HookRegistry();
      const [first, second] = [before(), before()];
      registry.register(Calculator, 'multiply', 'before', first);
      const snapshot = registry.handlersFor(Calculator, 'multiply', 'before');
      registry.register(Calculator, 'multiply', 'before', second);

      expect(snapshot).toEqual([first]);
      expect(registry.handlersFor(Calculator, 'multiply', 'before')).toEqual([first, second]);
    });

    it('never calls a handler, neither when registering nor when retrieving', () => {
      const registry = new HookRegistry();
      const beforeHandler = jest.fn<BeforeHandler<Args>>();
      const afterHandler = jest.fn<AfterHandler<Args, number>>();
      registry.register(Calculator, 'multiply', 'before', beforeHandler);
      registry.register(Calculator, 'multiply', 'after', afterHandler);
      registry.handlersFor(Calculator, 'multiply', 'before');
      registry.handlersFor(Calculator, 'multiply', 'after');
      expect(beforeHandler).not.toHaveBeenCalled();
      expect(afterHandler).not.toHaveBeenCalled();
    });

    it('does not look at the handler `this`: a bound handler is stored as it is', () => {
      class Hooks {
        calls = 0;
        count(): void {
          this.calls += 1;
        }
      }
      const hooks = new Hooks();
      const bound = hooks.count.bind(hooks);
      const registry = new HookRegistry();
      registry.register(Calculator, 'multiply', 'before', bound);
      expect(registry.handlersFor(Calculator, 'multiply', 'before')[0]).toBe(bound);
      expect(hooks.calls).toBe(0);
    });

    it('hands the runner what it needs, unchanged', async () => {
      const registry = new HookRegistry();
      registry.register(Calculator, 'multiply', 'before', ({ args }) => ({
        args: [args[0] + 1, args[1]],
      }));
      registry.register(Calculator, 'multiply', 'after', ({ result }) => ({ result: result * 10 }));

      const calculator = new Calculator();
      const result = await runWithHooks({
        method: calculator.multiply,
        thisArg: calculator,
        args: [2, 3] as Args,
        before: registry.handlersFor(Calculator, 'multiply', 'before'),
        after: registry.handlersFor(Calculator, 'multiply', 'after'),
        propagateExceptions: false,
        onHandlerError: () => undefined,
      });
      expect(result).toBe(90); // (2 + 1) * 3 * 10
    });
  });

  // The registrar passes values from type-erased metadata; these guard what the compiler cannot.
  describe('runtime checks (for callers that bypass the types)', () => {
    const registry = new HookRegistry();
    const register = registry.register.bind(registry) as (...args: unknown[]) => void;

    it('rejects an unknown phase', () => {
      expect(() => register(Calculator, 'multiply', 'around', before())).toThrow(
        'Unknown hook phase "around"',
      );
    });

    it('rejects a handler that is not a function', () => {
      expect(() => register(Calculator, 'multiply', 'before', 'nope')).toThrow(TypeError);
      expect(registry.handlersFor(Calculator, 'multiply', 'before')).toEqual([]);
    });
  });
});

/**
 * Compile-time checks: verified by `npm run typecheck`, NOT by jest (ts-jest is transpile-only
 * here). An unused `@ts-expect-error` is itself a compile error.
 */
describe('HookRegistry: type safety', () => {
  type Equal<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

  // The invalid calls below are only compiled, never run: some of them would throw or register
  // nonsense. A function that is declared but not called is still fully type-checked.
  it('only registers existing public async methods of a class', () => {
    const invalidCalls = (registry: HookRegistry): void => {
      // @ts-expect-error no such method
      registry.register(Calculator, 'nope', 'before', before());
      // @ts-expect-error a synchronous method cannot be customizable
      registry.register(Calculator, 'label', 'before', before());
      // @ts-expect-error private methods are not part of the public type
      registry.register(Calculator, 'secret', 'before', before());
      // @ts-expect-error the method belongs to another class
      registry.register(Other, 'add', 'before', before());
      // @ts-expect-error the target must be a class
      registry.register(new Calculator(), 'multiply', 'before', before());
      // @ts-expect-error only 'before' and 'after' exist
      registry.register(Calculator, 'multiply', 'around', before());
    };
    expect(invalidCalls).toBeInstanceOf(Function);
  });

  it('only registers a handler that fits the method and the phase', () => {
    const registry = new HookRegistry();
    registry.register(Calculator, 'multiply', 'before', ({ args }) => ({ args }));
    registry.register(Calculator, 'multiply', 'after', ({ result }) => ({ result }));

    const invalidCalls = (invalid: HookRegistry): void => {
      // @ts-expect-error the handler is for a method with other arguments
      invalid.register(Calculator, 'multiply', 'before', (_: { args: [string] }) => undefined);
      // @ts-expect-error an after handler needs `result`, which a before handler is not given
      invalid.register(Calculator, 'multiply', 'before', after());
      // @ts-expect-error a before handler replaces args, not the result
      invalid.register(Calculator, 'multiply', 'before', () => ({ result: 1 }));
      // @ts-expect-error the replacement result must be a number
      invalid.register(Calculator, 'multiply', 'after', () => ({ result: 'x' }));
    };
    expect(invalidCalls).toBeInstanceOf(Function);
    expect(registry.handlersFor(Calculator, 'multiply', 'before')).toHaveLength(1);
  });

  it('returns lists typed for the runner: arguments and result follow the method', () => {
    const registry = new HookRegistry();
    const beforeList = registry.handlersFor(Calculator, 'multiply', 'before');
    const afterList = registry.handlersFor(Calculator, 'add', 'after');
    const beforeType: Equal<typeof beforeList, readonly BeforeHandler<Args>[]> = true;
    const afterType: Equal<typeof afterList, readonly AfterHandler<Args, number>[]> = true;
    const handlerType: Equal<
      RegisteredHandler<Calculator, 'multiply', 'after'>,
      AfterHandler<MethodArgs<Calculator, 'multiply'>, MethodResult<Calculator, 'multiply'>>
    > = true;
    expect([beforeType, afterType, handlerType]).toEqual([true, true, true]);

    // @ts-expect-error the returned list is read-only, so it cannot be used as a mutable array
    const mutable: BeforeHandler<Args>[] = beforeList;
    expect(mutable).toEqual([]);
    expect(afterList).toEqual([]);
  });
});

/**
 * With a union as `method`, `phase` or `target` the compiler would check the handler against the
 * UNION of the possible handler types, so a handler that is right for only one member would be
 * accepted. The registry therefore asks for a single value; narrow a union first, then register.
 * Compile-only checks: verified by `npm run typecheck`, not by jest. The invalid calls sit in
 * functions that are never called, and each one is kept on a single line so that Prettier does not
 * move the error away from its `@ts-expect-error`.
 */
describe('HookRegistry: union keys must be narrowed before registering', () => {
  /** `run` and `text` have different arguments AND different results: that is what unions blur. */
  class Mixed {
    run(n: number): Promise<number> {
      return Promise.resolve(n);
    }

    text(s: string): Promise<string> {
      return Promise.resolve(s);
    }
  }
  class Stringy {
    run(n: number): Promise<string> {
      return Promise.resolve(String(n));
    }
  }
  class Base {
    run(n: number): Promise<number> {
      return Promise.resolve(n);
    }
  }
  class SameShape extends Base {}
  class NarrowerRun extends Base {
    override run(n: number): Promise<7> {
      void n;
      return Promise.resolve(7);
    }
  }

  const beforeRun: BeforeHandler<[n: number]> = ({ args }) => ({ args });
  const afterRun: AfterHandler<[n: number], number> = ({ result }) => ({ result });
  /** Fits every method and phase, so only the union itself can make a registration invalid. */
  const noop = (): void => undefined;

  it('rejects a union phase, method or target, however the handler is written', async () => {
    const invalid = (
      registry: HookRegistry,
      phase: HookPhase,
      method: 'run' | 'text',
      target: typeof Mixed | typeof Stringy,
      family: typeof Base | typeof NarrowerRun,
      nothing: never,
    ): void => {
      // @ts-expect-error `phase` may be 'before', but an after handler needs `result`
      registry.register(Mixed, 'run', phase, afterRun);
      // @ts-expect-error a before handler is not an after handler either
      registry.register(Mixed, 'run', phase, beforeRun);
      // @ts-expect-error `method` may be 'run', which returns a number, not a string
      registry.register(Mixed, method, 'after', () => ({ result: 'wrong for run' }));
      // @ts-expect-error even a handler that would fit every member is not accepted
      registry.register(Mixed, method, 'after', () => undefined);
      // @ts-expect-error both are unions
      registry.register(Mixed, method, phase, () => ({ result: 1 }));
      // @ts-expect-error `Stringy.run` returns a string, `Mixed.run` a number
      registry.register(target, 'run', 'after', () => ({ result: 'x' }));
      // @ts-expect-error `NarrowerRun.run` resolves to 7, the handler may replace it with any number
      registry.register(family, 'run', 'after', afterRun);
      // @ts-expect-error a union written out as explicit type arguments is rejected too
      registry.register<typeof Mixed, 'run' | 'text', 'after'>(Mixed, 'run', 'after', noop);
      // @ts-expect-error `never` leaves no handler type that could be right (not the union guard)
      registry.register(Mixed, 'run', nothing, afterRun);
    };
    expect(invalid).toBeInstanceOf(Function);
    // The fixture is real: this override resolves to 7, so a handler may not turn it into any number.
    await expect(new NarrowerRun().run(1)).resolves.toBe(7);
  });

  // Rejected by the union guard AND by the handler type, which cannot be resolved for a generic key.
  it('rejects a generic parameter, because its value is not known to be a single key', () => {
    const invalid = <P extends HookPhase, M extends 'run' | 'text'>(
      registry: HookRegistry,
      phase: P,
      method: M,
    ): void => {
      // @ts-expect-error `P` could be the whole union
      registry.register(Mixed, 'run', phase, afterRun);
      // @ts-expect-error `M` could be the whole union
      registry.register(Mixed, method, 'after', () => ({ result: 'x' }));
    };
    expect(invalid).toBeInstanceOf(Function);
  });

  it('accepts a union of classes that TypeScript cannot tell apart (same shape, same handlers)', () => {
    const registry = new HookRegistry();
    const target: typeof Base | typeof SameShape = SameShape;
    registry.register(target, 'run', 'after', afterRun); // no ts-expect-error: this must compile
    expect(registry.handlersFor(SameShape, 'run', 'after')).toEqual([afterRun]);
    expect(registry.handlersFor(Base, 'run', 'after')).toEqual([]); // filed under the real class
  });

  describe('narrowing a union first works', () => {
    it('narrows a phase with if', () => {
      const register = (registry: HookRegistry, phase: HookPhase): void => {
        if (phase === 'after') registry.register(Mixed, 'run', phase, afterRun);
      };
      const registry = new HookRegistry();
      register(registry, 'before');
      expect(registry.handlersFor(Mixed, 'run', 'after')).toEqual([]);
      register(registry, 'after');
      expect(registry.handlersFor(Mixed, 'run', 'after')).toEqual([afterRun]);
    });

    it('narrows a phase with switch, registering the handler that belongs to each case', () => {
      const register = (registry: HookRegistry, phase: HookPhase): void => {
        switch (phase) {
          case 'before':
            registry.register(Mixed, 'run', phase, beforeRun);
            break;
          case 'after':
            registry.register(Mixed, 'run', phase, afterRun);
            break;
        }
      };
      const registry = new HookRegistry();
      register(registry, 'before');
      register(registry, 'after');
      expect(registry.handlersFor(Mixed, 'run', 'before')).toEqual([beforeRun]);
      expect(registry.handlersFor(Mixed, 'run', 'after')).toEqual([afterRun]);
    });

    it('narrows a method, and the handler is then typed by that method', () => {
      const register = (registry: HookRegistry, method: 'run' | 'text'): void => {
        // `result` is a string here, not `number | string`: the narrowed method decides.
        if (method === 'text') {
          registry.register(Mixed, method, 'after', ({ result }) => ({ result: result.trim() }));
        }
        if (method === 'run') {
          registry.register(Mixed, method, 'before', ({ args }) => ({ args: [args[0] + 1] }));
        }
      };
      const registry = new HookRegistry();
      register(registry, 'text');
      register(registry, 'run');
      expect(registry.handlersFor(Mixed, 'text', 'after')).toHaveLength(1);
      expect(registry.handlersFor(Mixed, 'run', 'before')).toHaveLength(1);
      expect(registry.handlersFor(Mixed, 'run', 'after')).toEqual([]);
    });

    it('still accepts concrete before and after handlers, typed or inline', () => {
      const registry = new HookRegistry();
      registry.register(Mixed, 'run', 'before', beforeRun);
      registry.register(Mixed, 'run', 'after', afterRun);
      registry.register(Mixed, 'text', 'before', ({ args }) => ({ args }));
      registry.register(Stringy, 'run', 'after', ({ result }) => ({ result: result + '!' }));
      expect(registry.handlersFor(Mixed, 'run', 'before')).toEqual([beforeRun]);
      expect(registry.handlersFor(Mixed, 'run', 'after')).toEqual([afterRun]);
      expect(registry.handlersFor(Mixed, 'text', 'before')).toHaveLength(1);
      expect(registry.handlersFor(Stringy, 'run', 'after')).toHaveLength(1);
    });

    it('hands narrowed registrations to the runner unchanged', async () => {
      const registry = new HookRegistry();
      const register = (phase: HookPhase): void => {
        if (phase === 'before')
          registry.register(Mixed, 'run', phase, ({ args }) => ({ args: [args[0] + 1] }));
        if (phase === 'after')
          registry.register(Mixed, 'run', phase, ({ result }) => ({ result: result * 10 }));
      };
      register('before');
      register('after');

      const mixed = new Mixed();
      const result = await runWithHooks({
        method: mixed.run,
        thisArg: mixed,
        args: [4] as [n: number],
        before: registry.handlersFor(Mixed, 'run', 'before'),
        after: registry.handlersFor(Mixed, 'run', 'after'),
        propagateExceptions: false,
        onHandlerError: () => undefined,
      });
      expect(result).toBe(50); // (4 + 1) * 10
    });
  });
});
