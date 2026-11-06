import { jest } from '@jest/globals';
import { CUSTOMIZABLE_KEY, Customizable } from './customizable.decorator.js';
import { HookRegistry } from './hook-registry.js';
import type { AfterHandler, BeforeHandler, HookFailure } from './hook-runner.js';
import { checkWrappable, wrapMethod, type WrapResult } from './method-wrapper.js';

type Args = [a: number, b: number];

/** Everything the fixtures do, in order. */
const events: string[] = [];
beforeEach(() => {
  events.length = 0;
});

/** Test fixture; nothing to do with a real service. */
class Calculator {
  constructor(readonly offset = 100) {}

  coreCalls = 0;

  @Customizable()
  multiply(a: number, b: number): Promise<number> {
    this.coreCalls += 1;
    events.push(`core(${a},${b})`);
    return Promise.resolve(a * b + this.offset);
  }

  @Customizable({ propagateExceptions: true })
  strict(a: number, b: number): Promise<number> {
    this.coreCalls += 1;
    events.push('core:strict');
    return Promise.resolve(a + b);
  }

  @Customizable()
  failing(): Promise<number> {
    this.coreCalls += 1;
    return Promise.reject(new Error('core failure'));
  }

  @Customizable()
  nothing(): Promise<undefined> {
    this.coreCalls += 1;
    return Promise.resolve(undefined);
  }

  @Customizable()
  join(separator: string = ',', ...rest: string[]): Promise<string> {
    return Promise.resolve(rest.join(separator));
  }

  @Customizable()
  async slow(label: string, ms: number): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return label;
  }

  @Customizable()
  maybe(): Promise<number | undefined> {
    return Promise.resolve(5);
  }

  /** Async but NOT customizable. */
  plain(): Promise<void> {
    return Promise.resolve();
  }

  get fast(): Promise<number> {
    return Promise.resolve(1);
  }
}
Object.defineProperty(Calculator.prototype, 'constant', { value: 5 });

class OverridingCalculator extends Calculator {
  @Customizable()
  override multiply(a: number, b: number): Promise<number> {
    return Promise.resolve(a * b);
  }
}

class Unrelated {
  @Customizable()
  multiply(): Promise<number> {
    return Promise.resolve(0);
  }
}

const plus =
  (n: number): BeforeHandler<Args> =>
  ({ args }) => ({ args: [args[0] + n, args[1]] });
const times =
  (n: number): AfterHandler<Args, number> =>
  ({ result }) => ({ result: result * n });

function setup(): {
  registry: HookRegistry;
  failures: HookFailure[];
  onHandlerError: jest.Mock<(f: HookFailure) => void>;
} {
  const failures: HookFailure[] = [];
  const onHandlerError = jest.fn((failure: HookFailure) => {
    failures.push(failure);
  });
  return { registry: new HookRegistry(), failures, onHandlerError };
}

function wrapped(
  instance: object,
  registry: HookRegistry,
  method: string,
  onHandlerError: (failure: HookFailure) => void = () => undefined,
): void {
  const result = wrapMethod(instance, Calculator, method, { registry, onHandlerError });
  expect(result).toEqual({ ok: true });
}

const problemOf = (result: WrapResult): string => {
  if (result.ok) throw new Error('expected a problem');
  return result.problem.code;
};

describe('wrapMethod', () => {
  describe('execution', () => {
    it('runs before hooks, the core method once, then after hooks, in registration order', async () => {
      const { registry } = setup();
      registry.register(Calculator, 'multiply', 'before', () => void events.push('before1'));
      registry.register(Calculator, 'multiply', 'before', () => void events.push('before2'));
      registry.register(Calculator, 'multiply', 'after', () => void events.push('after1'));
      registry.register(Calculator, 'multiply', 'after', () => void events.push('after2'));
      const calculator = new Calculator();
      wrapped(calculator, registry, 'multiply');

      await calculator.multiply(2, 3);

      expect(events).toEqual(['before1', 'before2', 'core(2,3)', 'after1', 'after2']);
      expect(calculator.coreCalls).toBe(1);
    });

    it('lets a before hook change the arguments and an after hook change the result', async () => {
      const { registry } = setup();
      registry.register(Calculator, 'multiply', 'before', plus(1));
      registry.register(Calculator, 'multiply', 'before', plus(1));
      registry.register(Calculator, 'multiply', 'after', times(10));
      const calculator = new Calculator(0);
      wrapped(calculator, registry, 'multiply');

      expect(await calculator.multiply(2, 3)).toBe((2 + 2) * 3 * 10);
      expect(events).toEqual(['core(4,3)']);
    });

    it('shares one context between the before and after hooks of a call', async () => {
      const { registry } = setup();
      registry.register(Calculator, 'multiply', 'before', ({ ctx }) => {
        ctx.seen = 'from before';
      });
      let seen: unknown;
      registry.register(Calculator, 'multiply', 'after', ({ ctx }) => {
        seen = ctx.seen;
      });
      const calculator = new Calculator();
      wrapped(calculator, registry, 'multiply');
      await calculator.multiply(1, 1);
      expect(seen).toBe('from before');
    });

    it("keeps the caller's receiver for the original method", async () => {
      const { registry } = setup();
      registry.register(Calculator, 'multiply', 'after', times(1));
      const calculator = new Calculator(100);
      wrapped(calculator, registry, 'multiply');

      expect(await calculator.multiply(1, 1)).toBe(101);
      // Called with another receiver, as a plain method would be: that receiver is `this`.
      expect(await calculator.multiply.call(new Calculator(7), 1, 1)).toBe(8);
      // Detached, the core method sees `this === undefined` and fails. The original (not an `async`
      // function) would throw synchronously; the wrapper always returns a promise, so it rejects.
      const detached = calculator.multiply;
      expect(() => Calculator.prototype.multiply.call(undefined, 1, 1)).toThrow(TypeError);
      await expect(detached(1, 1)).rejects.toBeInstanceOf(TypeError);
    });

    it('keeps a resolved undefined and lets a hook replace a result with undefined', async () => {
      const { registry } = setup();
      const calculator = new Calculator();
      wrapped(calculator, registry, 'nothing');
      expect(await calculator.nothing()).toBeUndefined();

      registry.register(Calculator, 'maybe', 'after', () => ({ result: undefined }));
      wrapped(calculator, registry, 'maybe');
      expect(await calculator.maybe()).toBeUndefined();
    });

    it('passes optional and rest arguments through exactly', async () => {
      const { registry } = setup();
      const calculator = new Calculator();
      wrapped(calculator, registry, 'join');
      expect(await calculator.join()).toBe('');
      expect(await calculator.join('-', 'a', 'b', 'c')).toBe('a-b-c');

      registry.register(Calculator, 'join', 'before', ({ args }) => ({
        args: [args[0], ...args.slice(1), 'extra'] as [sep?: string, ...rest: string[]],
      }));
      expect(await calculator.join('+', 'x')).toBe('x+extra');
    });

    it('reads the registry on every call: hooks registered later apply from then on', async () => {
      const { registry } = setup();
      const calculator = new Calculator(0);
      wrapped(calculator, registry, 'multiply');
      expect(await calculator.multiply(2, 2)).toBe(4);
      registry.register(Calculator, 'multiply', 'after', times(2));
      expect(await calculator.multiply(2, 2)).toBe(8);
    });

    it('gives concurrent calls independent contexts', async () => {
      const { registry } = setup();
      registry.register(Calculator, 'slow', 'before', ({ args, ctx }) => {
        ctx.label = args[0];
      });
      const seen: unknown[] = [];
      registry.register(Calculator, 'slow', 'after', ({ ctx, result }) => {
        seen.push([ctx.label, result]);
      });
      const calculator = new Calculator();
      wrapped(calculator, registry, 'slow');

      await Promise.all([
        calculator.slow('a', 15),
        calculator.slow('b', 1),
        calculator.slow('c', 8),
      ]);
      expect(seen).toEqual([
        ['b', 'b'],
        ['c', 'c'],
        ['a', 'a'],
      ]);
    });
  });

  describe('errors', () => {
    it('propagates a core error unchanged, skips after hooks and reports nothing', async () => {
      const { registry, onHandlerError } = setup();
      registry.register(Calculator, 'failing', 'after', () => void events.push('after'));
      const calculator = new Calculator();
      wrapped(calculator, registry, 'failing', onHandlerError);

      await expect(calculator.failing()).rejects.toThrow('core failure');
      expect(events).toEqual([]);
      expect(onHandlerError).not.toHaveBeenCalled();
    });

    it('by default ignores a failing hook, reports it, and carries on', async () => {
      const { registry, failures, onHandlerError } = setup();
      const broken = new Error('hook failure');
      registry.register(Calculator, 'multiply', 'before', () => {
        throw broken;
      });
      registry.register(Calculator, 'multiply', 'after', () => Promise.reject(broken));
      registry.register(Calculator, 'multiply', 'after', times(2));
      const calculator = new Calculator(0);
      wrapped(calculator, registry, 'multiply', onHandlerError);

      expect(await calculator.multiply(2, 3)).toBe(12);
      expect(failures.map(({ phase, index }) => [phase, index])).toEqual([
        ['before', 0],
        ['after', 0],
      ]);
      expect(failures[0].error).toBe(broken);
      expect(calculator.coreCalls).toBe(1);
    });

    it('with propagateExceptions, rethrows a failing before hook and never runs the core method', async () => {
      const { registry, onHandlerError } = setup();
      const broken = new Error('hook failure');
      registry.register(Calculator, 'strict', 'before', () => {
        throw broken;
      });
      const calculator = new Calculator();
      wrapped(calculator, registry, 'strict', onHandlerError);

      await expect(calculator.strict(1, 2)).rejects.toBe(broken);
      expect(calculator.coreCalls).toBe(0);
      expect(onHandlerError).not.toHaveBeenCalled();
    });

    it('with propagateExceptions, rethrows a failing after hook too', async () => {
      const { registry } = setup();
      const broken = new Error('late failure');
      registry.register(Calculator, 'strict', 'after', () => {
        throw broken;
      });
      const calculator = new Calculator();
      wrapped(calculator, registry, 'strict');
      await expect(calculator.strict(1, 2)).rejects.toBe(broken);
      expect(calculator.coreCalls).toBe(1);
    });

    it('treats a malformed return value as a failing hook', async () => {
      const { registry, failures, onHandlerError } = setup();
      registry.register(
        Calculator,
        'multiply',
        'before',
        (() => 5) as unknown as BeforeHandler<Args>,
      );
      const calculator = new Calculator(0);
      wrapped(calculator, registry, 'multiply', onHandlerError);
      expect(await calculator.multiply(2, 3)).toBe(6);
      expect(failures).toHaveLength(1);
    });

    it("survives a reporting callback that throws, under the runner's policy", async () => {
      const { registry } = setup();
      registry.register(Calculator, 'multiply', 'before', () => {
        throw new Error('hook failure');
      });
      registry.register(Calculator, 'multiply', 'after', times(2));
      const calculator = new Calculator(0);
      wrapped(calculator, registry, 'multiply', () => {
        throw new Error('reporter failure');
      });
      expect(await calculator.multiply(2, 3)).toBe(12);
    });
  });

  describe('installation', () => {
    it('installs a non-enumerable own property on the instance and leaves the prototype alone', () => {
      const { registry } = setup();
      const before = Object.getOwnPropertyDescriptor(Calculator.prototype, 'multiply');
      const keys = Object.keys(new Calculator());
      const calculator = new Calculator();
      const bystander = new Calculator();
      wrapped(calculator, registry, 'multiply');

      expect(Object.getOwnPropertyDescriptor(Calculator.prototype, 'multiply')).toEqual(before);
      expect(Object.hasOwn(calculator, 'multiply')).toBe(true);
      expect(Object.keys(calculator)).toEqual(keys);
      expect(Object.hasOwn(bystander, 'multiply')).toBe(false);
      expect(bystander.multiply).toBe(Calculator.prototype.multiply);
      expect(calculator.multiply).not.toBe(Calculator.prototype.multiply);
    });

    it('works when the prototype method is read-only', async () => {
      class Frozen {
        @Customizable()
        run(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      Object.defineProperty(Frozen.prototype, 'run', { writable: false });
      const { registry } = setup();
      const instance = new Frozen();
      expect(
        wrapMethod(instance, Frozen, 'run', { registry, onHandlerError: () => undefined }),
      ).toEqual({
        ok: true,
      });
      expect(await instance.run()).toBe(1);
    });

    it('refuses to wrap the same method of the same instance twice, and runs hooks once', async () => {
      const { registry } = setup();
      registry.register(Calculator, 'multiply', 'after', times(2));
      const calculator = new Calculator(0);
      wrapped(calculator, registry, 'multiply');
      const installed = calculator.multiply;

      const again = wrapMethod(calculator, Calculator, 'multiply', {
        registry,
        onHandlerError: () => undefined,
      });
      expect(problemOf(again)).toBe('already-wrapped');
      expect(problemOf(checkWrappable(calculator, Calculator, 'multiply'))).toBe('already-wrapped');
      // Another registry (another application sharing the instance) is refused as well.
      expect(
        problemOf(
          wrapMethod(calculator, Calculator, 'multiply', {
            registry: new HookRegistry(),
            onHandlerError: () => undefined,
          }),
        ),
      ).toBe('already-wrapped');

      expect(calculator.multiply).toBe(installed);
      expect(await calculator.multiply(2, 3)).toBe(12); // doubled once, not twice
    });

    it('wraps different methods of one instance independently', async () => {
      const { registry } = setup();
      const calculator = new Calculator(0);
      wrapped(calculator, registry, 'multiply');
      wrapped(calculator, registry, 'strict');
      expect(await calculator.strict(1, 2)).toBe(3);
    });

    it('gives separate instances separate hooks when they use separate registries', async () => {
      const one = setup();
      const two = setup();
      one.registry.register(Calculator, 'multiply', 'after', times(10));
      two.registry.register(Calculator, 'multiply', 'after', times(100));
      const first = new Calculator(0);
      const second = new Calculator(0);
      const third = new Calculator(0);
      wrapped(first, one.registry, 'multiply');
      wrapped(second, two.registry, 'multiply');

      expect(await first.multiply(1, 2)).toBe(20);
      expect(await second.multiply(1, 2)).toBe(200);
      expect(await third.multiply(1, 2)).toBe(2); // never wrapped
    });

    it('dry-run: checkWrappable changes nothing, and the real call then succeeds', () => {
      const { registry } = setup();
      const calculator = new Calculator();
      expect(checkWrappable(calculator, Calculator, 'multiply')).toEqual({ ok: true });
      expect(Object.hasOwn(calculator, 'multiply')).toBe(false);
      wrapped(calculator, registry, 'multiply');
    });
  });

  describe('methods that cannot be wrapped', () => {
    const noop = { registry: new HookRegistry(), onHandlerError: () => undefined };

    /** Both entry points must agree, and neither may touch the instance. */
    function expectProblem(
      instance: unknown,
      target: unknown,
      method: unknown,
      code: string,
    ): void {
      const keysBefore = typeof instance === 'object' && instance ? Reflect.ownKeys(instance) : [];
      for (const run of [
        () => checkWrappable(instance, target as typeof Calculator, method as string),
        () => wrapMethod(instance, target as typeof Calculator, method as string, noop),
      ]) {
        const result = run();
        expect(problemOf(result)).toBe(code);
      }
      if (typeof instance === 'object' && instance) {
        expect(Reflect.ownKeys(instance)).toEqual(keysBefore);
      }
    }

    it.each([[null], [undefined], ['x'], [5]])(
      'an instance that is not an object: %p',
      (instance) => {
        expectProblem(instance, Calculator, 'multiply', 'invalid-instance');
      },
    );

    it.each([[undefined], [null], [() => undefined], [{}], ['Calculator']])(
      'a target that is not a class: %p',
      (target) => {
        expectProblem(new Calculator(), target, 'multiply', 'invalid-target');
      },
    );

    it.each([[''], [undefined], [1]])(
      'a method name that is not a non-empty string: %p',
      (method) => {
        expectProblem(new Calculator(), Calculator, method, 'invalid-method-name');
      },
    );

    it('a method the target does not declare', () => {
      expectProblem(new Calculator(), Calculator, 'nope', 'method-not-found');
    });

    it('a getter', () => {
      expectProblem(new Calculator(), Calculator, 'fast', 'method-is-accessor');
    });

    it('a non-function property', () => {
      expectProblem(new Calculator(), Calculator, 'constant', 'method-not-function');
    });

    it('a method without @Customizable()', () => {
      expectProblem(new Calculator(), Calculator, 'plain', 'not-customizable');
    });

    it('an instance whose class overrides the method: hook the class that runs it', () => {
      const instance = new OverridingCalculator();
      expectProblem(instance, Calculator, 'multiply', 'method-replaced');
      expect(checkWrappable(instance, OverridingCalculator, 'multiply')).toEqual({ ok: true });
    });

    it('an instance that shadows the method with its own property', () => {
      const instance = new Calculator();
      Object.defineProperty(instance, 'multiply', { value: () => Promise.resolve(0) });
      expectProblem(instance, Calculator, 'multiply', 'method-replaced');
    });

    it('an instance of an unrelated class', () => {
      expectProblem(new Unrelated(), Calculator, 'multiply', 'method-replaced');
      expectProblem({}, Calculator, 'multiply', 'method-replaced');
    });

    it('a frozen instance', () => {
      expectProblem(Object.freeze(new Calculator()), Calculator, 'multiply', 'not-extensible');
    });

    it('an own property that holds the original function, even a non-replaceable one', () => {
      const locked = new Calculator();
      Object.defineProperty(locked, 'multiply', { value: Calculator.prototype.multiply });
      expectProblem(locked, Calculator, 'multiply', 'method-replaced');

      const plain = new Calculator();
      plain.multiply = Calculator.prototype.multiply;
      expectProblem(plain, Calculator, 'multiply', 'method-replaced');
    });

    it('a failed installation is a problem, leaves the instance as it was, and hides the error', () => {
      const secret = 'password=hunter2';
      const instance = new Calculator();
      const hostile = new Proxy(instance, {
        defineProperty() {
          throw new Error(secret);
        },
      });
      const options = { registry: new HookRegistry(), onHandlerError: () => undefined };
      expect(checkWrappable(hostile, Calculator, 'multiply')).toEqual({ ok: true });

      const result = wrapMethod(hostile, Calculator, 'multiply', options);

      expect(problemOf(result)).toBe('install-failed');
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(Object.hasOwn(instance, 'multiply')).toBe(false);
      expect(instance.multiply).toBe(Calculator.prototype.multiply);
    });

    it('a refused definition (trap returning false) is a problem too', () => {
      const instance = new Calculator();
      const hostile = new Proxy(instance, { defineProperty: () => false });
      const result = wrapMethod(hostile, Calculator, 'multiply', {
        registry: new HookRegistry(),
        onHandlerError: () => undefined,
      });
      expect(problemOf(result)).toBe('install-failed');
      expect(Object.hasOwn(instance, 'multiply')).toBe(false);
    });

    describe('metadata accessors are never run', () => {
      class Service {
        @Customizable()
        run(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      const options = { registry: new HookRegistry(), onHandlerError: () => undefined };

      it.each([
        [
          'throwing',
          () => {
            throw new Error('metadata accessor failed');
          },
        ],
        ['side-effecting', () => true],
      ])('%s propagateExceptions getter', (_name, get) => {
        const reads = jest.fn(get);
        Reflect.defineMetadata(
          CUSTOMIZABLE_KEY,
          Object.defineProperty({}, 'propagateExceptions', { get: reads, enumerable: true }),
          Service.prototype.run,
        );
        const instance = new Service();

        expect(problemOf(checkWrappable(instance, Service, 'run'))).toBe('not-customizable');
        expect(problemOf(wrapMethod(instance, Service, 'run', options))).toBe('not-customizable');
        expect(reads).not.toHaveBeenCalled();
        expect(Object.hasOwn(instance, 'run')).toBe(false);
      });

      it.each([
        ['a string', 'true'],
        ['a number', 1],
        ['missing', undefined],
      ])('a propagateExceptions value that is %s', (_name, value) => {
        Reflect.defineMetadata(
          CUSTOMIZABLE_KEY,
          { propagateExceptions: value },
          Service.prototype.run,
        );
        expect(problemOf(checkWrappable(new Service(), Service, 'run'))).toBe('not-customizable');
      });
    });

    it('describes the problem without any values', () => {
      const result = checkWrappable(new Calculator(), Calculator, 'plain');
      expect(result).toEqual({
        ok: false,
        problem: {
          code: 'not-customizable',
          message: 'Calculator.plain: it is not marked @Customizable()',
        },
      });
    });
  });

  describe('sensitive data', () => {
    it('emits nothing to the console or the process streams, and reports only through the callback', async () => {
      const spies = [
        jest.spyOn(console, 'log'),
        jest.spyOn(console, 'info'),
        jest.spyOn(console, 'warn'),
        jest.spyOn(console, 'error'),
        jest.spyOn(console, 'debug'),
        jest.spyOn(process.stdout, 'write'),
        jest.spyOn(process.stderr, 'write'),
      ];
      try {
        const { registry, failures, onHandlerError } = setup();
        const secretError = new Error('password=hunter2 Bearer abc.def.ghi');
        registry.register(Calculator, 'multiply', 'before', () => {
          throw secretError;
        });
        registry.register(Calculator, 'multiply', 'after', ({ ctx }) => {
          ctx.token = 'Bearer abc.def.ghi';
        });
        registry.register(Calculator, 'strict', 'after', () => {
          throw secretError;
        });
        const calculator = new Calculator(4242);
        wrapped(calculator, registry, 'multiply', onHandlerError);
        wrapped(calculator, registry, 'strict', onHandlerError);

        const ignored = await calculator.multiply(1000, 1);
        await expect(calculator.strict(7, 7)).rejects.toBe(secretError);

        // The caller gets exactly what the core method returned, nothing added.
        expect(ignored).toBe(1000 * 1 + 4242);
        // The error went to the callback, untouched (sanitising it is the reporter's job)...
        expect(failures).toHaveLength(1);
        expect(failures[0].error).toBe(secretError);
        // ...and nowhere else.
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        jest.restoreAllMocks();
      }
    });

    it('adds nothing to the value it returns or to the error it throws', async () => {
      const { registry } = setup();
      const calculator = new Calculator();
      wrapped(calculator, registry, 'failing');
      const error = await calculator.failing().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(Object.keys(error as Error)).toEqual([]);
      expect((error as Error).message).toBe('core failure');
    });
  });
});
