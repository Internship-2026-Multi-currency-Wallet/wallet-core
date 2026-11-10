import { jest } from '@jest/globals';
import {
  type AfterHandler,
  type AfterPayload,
  type BeforeHandler,
  type BeforePayload,
  type HookFailure,
  type HookRun,
  runWithHooks,
} from './hook-runner.js';
import type { AfterHook, BeforeHook, HookContext, MethodArgs, MethodResult } from './hook.types.js';

type Args = [a: number, b: number];

/** Test fixture: `this` matters (`factor`) and every execution is recorded. */
class Calculator {
  readonly calls: Args[] = [];

  constructor(readonly factor = 10) {}

  multiply(a: number, b: number): Promise<number> {
    this.calls.push([a, b]);
    return Promise.resolve(a * b * this.factor);
  }
}

type Run = HookRun<Calculator, Args, number>;
const boom = new Error('boom');
const explode = (): never => {
  throw boom;
};

function setup(factor?: number) {
  const calc = new Calculator(factor);
  const failures: HookFailure[] = [];
  /** Runs `calc.multiply(2, 3)` through the runner; override any part of the run. */
  const run = (more: Partial<Run> = {}) =>
    runWithHooks<Calculator, Args, number>({
      method: calc.multiply,
      thisArg: calc,
      args: [2, 3],
      before: [],
      after: [],
      propagateExceptions: false,
      onHandlerError: (failure) => {
        failures.push(failure);
      },
      ...more,
    });
  return { calc, failures, run };
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('runWithHooks: flow', () => {
  it('returns the method result when there are no hooks', async () => {
    const { calc, run } = setup();
    await expect(run()).resolves.toBe(60);
    expect(calc.calls).toEqual([[2, 3]]);
  });

  it('runs before handlers, then the method, then after handlers', async () => {
    const events: string[] = [];
    const { run } = setup();
    await run({
      before: [() => void events.push('before 1'), () => void events.push('before 2')],
      method: function (this: Calculator, a, b) {
        events.push('method');
        return this.multiply(a, b);
      },
      after: [() => void events.push('after 1'), () => void events.push('after 2')],
    });
    expect(events).toEqual(['before 1', 'before 2', 'method', 'after 1', 'after 2']);
  });

  it('awaits each handler before starting the next step (controlled promises)', async () => {
    const events: string[] = [];
    const [before1, before2, after1] = [deferred(), deferred(), deferred()];
    const { run } = setup();
    const pending = run({
      before: [
        async () => {
          events.push('before 1 start');
          await before1.promise;
          events.push('before 1 end');
        },
        async () => {
          events.push('before 2 start');
          await before2.promise;
          events.push('before 2 end');
        },
      ],
      method: function (this: Calculator, a, b) {
        events.push('method');
        return this.multiply(a, b);
      },
      after: [
        async () => {
          events.push('after 1 start');
          await after1.promise;
          events.push('after 1 end');
        },
        () => void events.push('after 2'),
      ],
    });

    await flush();
    expect(events).toEqual(['before 1 start']); // the second handler waits for the first
    before1.resolve();
    await flush();
    expect(events.slice(1)).toEqual(['before 1 end', 'before 2 start']);
    before2.resolve();
    await flush();
    expect(events.slice(3)).toEqual(['before 2 end', 'method', 'after 1 start']);
    after1.resolve();
    await pending;
    expect(events.slice(6)).toEqual(['after 1 end', 'after 2']);
  });

  it('calls the original method exactly once, whatever the hooks do', async () => {
    const method = jest.fn((a: number, b: number) => Promise.resolve(a + b));
    const base = { method, thisArg: null, args: [1, 2] as Args, propagateExceptions: false };
    await runWithHooks<null, Args, number>({
      ...base,
      onHandlerError: () => undefined,
      before: [({ args }) => ({ args: [args[0] + 1, args[1]] }), explode],
      after: [explode, () => ({ result: 0 })],
    });
    expect(method).toHaveBeenCalledTimes(1);
    expect(method).toHaveBeenCalledWith(2, 2);
  });

  it('calls the method with this = thisArg, even when the method is detached', async () => {
    const { calc, run } = setup(7);
    const { multiply } = calc;
    await expect(run({ method: multiply })).resolves.toBe(42); // 2 * 3 * 7
  });

  it('uses the handlers a call started with, even if the lists change meanwhile', async () => {
    const events: string[] = [];
    const before: BeforeHandler<Args>[] = [];
    before.push(() => {
      events.push('first');
      before.push(() => void events.push('added too late'));
    });
    const { run } = setup();
    await run({ before });
    expect(events).toEqual(['first']);
  });

  it('also uses the after handlers it started with when a before handler changes that list', async () => {
    const events: string[] = [];
    const after: AfterHandler<Args, number>[] = [() => void events.push('original')];
    const { run } = setup();
    await run({
      before: [
        () => {
          after.splice(0, 1, () => void events.push('replacement'));
          after.push(() => void events.push('added'));
        },
      ],
      after,
    });
    expect(events).toEqual(['original']);
  });

  it('works when the method resolves to undefined', async () => {
    const seen: unknown[] = [];
    const result = await runWithHooks<null, [], void>({
      method: () => Promise.resolve(),
      thisArg: null,
      args: [],
      before: [],
      after: [({ result }) => void seen.push(result), () => undefined],
      propagateExceptions: false,
      onHandlerError: () => undefined,
    });
    expect(result).toBeUndefined();
    expect(seen).toEqual([undefined]);
  });
});

describe('runWithHooks: changing data by returning a replacement', () => {
  it('a before handler replaces the arguments; later handlers and the method see them', async () => {
    const seen: Args[] = [];
    const { calc, run } = setup();
    await run({
      before: [
        ({ args }) => ({ args: [args[0] + 1, args[1]] }),
        async ({ args }) => {
          seen.push(args);
          await Promise.resolve();
          return { args: [args[0], args[1] + 1] };
        },
        ({ args }) => void seen.push(args),
      ],
    });
    expect(seen).toEqual([
      [3, 3],
      [3, 4],
    ]);
    expect(calc.calls).toEqual([[3, 4]]);
  });

  it('an after handler replaces the result; later handlers see it, and so do the final args', async () => {
    const seen: [Args, number][] = [];
    const { run } = setup();
    const result = await run({
      before: [() => ({ args: [4, 5] })],
      after: [
        ({ args, result }) => {
          seen.push([args, result]);
          return { result: result + 1 };
        },
        async ({ args, result }) => {
          seen.push([args, result]);
          await Promise.resolve();
          return { result: result * 2 };
        },
      ],
    });
    expect(seen).toEqual([
      [[4, 5], 200],
      [[4, 5], 201],
    ]);
    expect(result).toBe(402);
  });

  it('returning undefined (or nothing) keeps the previous value', async () => {
    const { calc, run } = setup();
    const result = await run({
      before: [() => undefined, () => {}, async () => {}],
      after: [() => undefined, () => {}, async () => {}],
    });
    expect(result).toBe(60);
    expect(calc.calls).toEqual([[2, 3]]);
  });

  it('{ result: undefined } replaces the result with undefined, when the type allows it', async () => {
    const find = runWithHooks<null, [id: string], string | undefined>({
      method: () => Promise.resolve('found'),
      thisArg: null,
      args: ['1'],
      before: [],
      after: [() => ({ result: undefined })],
      propagateExceptions: false,
      onHandlerError: () => undefined,
    });
    await expect(find).resolves.toBeUndefined();
  });

  it('the payload ctx is shared by before and after of one call', async () => {
    const seen: HookContext[] = [];
    const { run } = setup();
    await run({
      before: [
        ({ ctx }) => {
          ctx.startedBy = 'before';
          seen.push(ctx);
        },
      ],
      after: [
        ({ ctx }) => {
          seen.push(ctx);
          return { result: ctx.startedBy === 'before' ? 1 : 0 };
        },
      ],
    }).then((result) => expect(result).toBe(1));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it('gives every invocation its own ctx, also when invocations overlap', async () => {
    const [gateA, gateB] = [deferred(), deferred()];
    const owners: Record<string, unknown> = {};
    const contexts: HookContext[] = [];
    const { run } = setup();
    const call = (name: string, gate: ReturnType<typeof deferred>) =>
      run({
        args: [name.length, 1],
        before: [
          async ({ ctx }) => {
            ctx.owner = name;
            contexts.push(ctx);
            await gate.promise;
          },
        ],
        after: [({ ctx }) => void (owners[name] = ctx.owner)],
      });

    const [a, b] = [call('A', gateA), call('Bee', gateB)];
    await flush();
    gateB.resolve(); // finish in the opposite order of starting
    await b;
    gateA.resolve();
    await a;

    expect(owners).toEqual({ A: 'A', Bee: 'Bee' });
    expect(contexts[0]).not.toBe(contexts[1]);
  });
});

describe('runWithHooks: errors', () => {
  it('reports a failing handler and carries on with the last accepted values', async () => {
    const seen: Args[] = [];
    const { calc, failures, run } = setup();
    const result = await run({
      before: [
        ({ args }) => ({ args: [args[0] + 1, args[1]] }),
        explode,
        ({ args }) => {
          seen.push(args);
          return { args: [args[0] + 1, args[1]] };
        },
      ],
    });
    expect(seen).toEqual([[3, 3]]); // the failed handler left no trace
    expect(calc.calls).toEqual([[4, 3]]);
    expect(result).toBe(120);
    expect(failures).toEqual([{ phase: 'before', index: 1, handler: 'explode', error: boom }]);
  });

  it('also ignores a rejected after handler and keeps the last accepted result', async () => {
    const rejecting = async (): Promise<never> => {
      await Promise.resolve();
      throw boom;
    };
    const { failures, run } = setup();
    const result = await run({
      after: [
        ({ result }) => ({ result: result + 1 }),
        rejecting,
        ({ result }) => ({ result: result + 1 }),
      ],
    });
    expect(result).toBe(62);
    expect(failures).toEqual([{ phase: 'after', index: 1, handler: 'rejecting', error: boom }]);
  });

  // Handlers are type-erased once collected by a registrar, so a wrong return value is possible.
  // It counts as a failing handler and must never reach the core call.
  it.each([
    ['an array instead of { args }', () => [4, 5]],
    ['args that is not an array', () => ({ args: 5 })],
    ['an object without args', () => ({})],
    ['null', () => null],
  ])('treats a before handler returning %s as a failing handler', async (_name, handler) => {
    const { calc, failures, run } = setup();
    await expect(run({ before: [handler as unknown as BeforeHandler<Args>] })).resolves.toBe(60);
    expect(calc.calls).toEqual([[2, 3]]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ phase: 'before', index: 0, handler: '(anonymous)' });
    expect(failures[0].error).toBeInstanceOf(TypeError);
  });

  it.each([
    ['the bare value instead of { result }', () => 5],
    ['an object without result', () => ({ results: 5 })],
    ['null', () => null],
  ])('treats an after handler returning %s as a failing handler', async (_name, handler) => {
    const { failures, run } = setup();
    await expect(run({ after: [handler as unknown as AfterHandler<Args, number>] })).resolves.toBe(
      60,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ phase: 'after', index: 0 });
    expect(failures[0].error).toBeInstanceOf(TypeError);
  });

  it('with propagateExceptions, a failing before handler stops everything', async () => {
    const later = jest.fn<BeforeHandler<Args>>();
    const afterHandler = jest.fn<AfterHandler<Args, number>>();
    const { calc, failures, run } = setup();
    await expect(
      run({ propagateExceptions: true, before: [explode, later], after: [afterHandler] }),
    ).rejects.toBe(boom);
    expect(later).not.toHaveBeenCalled();
    expect(calc.calls).toEqual([]); // the method never ran
    expect(afterHandler).not.toHaveBeenCalled();
    expect(failures).toEqual([]); // propagated, not "ignored and logged"
  });

  it('with propagateExceptions, a failing after handler stops the remaining after handlers', async () => {
    const later = jest.fn<AfterHandler<Args, number>>();
    const { calc, failures, run } = setup();
    await expect(
      run({ propagateExceptions: true, after: [() => ({ result: 1 }), explode, later] }),
    ).rejects.toBe(boom);
    expect(later).not.toHaveBeenCalled();
    expect(calc.calls).toEqual([[2, 3]]); // too late to undo: the method has already run
    expect(failures).toEqual([]);
  });

  it('with propagateExceptions, a malformed return value propagates as a TypeError', async () => {
    const { run } = setup();
    const malformed = (() => 5) as unknown as AfterHandler<Args, number>;
    await expect(run({ propagateExceptions: true, after: [malformed] })).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it.each([false, true])(
    'a core method error propagates unchanged and skips after handlers (propagateExceptions: %s)',
    async (propagateExceptions) => {
      const coreError = new Error('core failed');
      const beforeHandler = jest.fn<BeforeHandler<Args>>();
      const afterHandler = jest.fn<AfterHandler<Args, number>>();
      const { failures, run } = setup();
      await expect(
        run({
          propagateExceptions,
          method: () => Promise.reject(coreError),
          before: [beforeHandler],
          after: [afterHandler],
        }),
      ).rejects.toBe(coreError);
      expect(beforeHandler).toHaveBeenCalledTimes(1);
      expect(afterHandler).not.toHaveBeenCalled();
      expect(failures).toEqual([]); // a core error is not a hook failure
    },
  );

  // Documents what is NOT promised: payload values are passed by reference, with no rollback.
  it('does not roll back an in-place mutation made by a handler that then fails', async () => {
    const input = { amount: 1 };
    const method = jest.fn((value: { amount: number }) => Promise.resolve(value.amount));
    const result = await runWithHooks({
      method,
      thisArg: null,
      args: [input],
      before: [
        ({ args }) => {
          args[0].amount = 99;
          throw boom;
        },
      ],
      after: [],
      propagateExceptions: false,
      onHandlerError: () => undefined,
    });
    expect(result).toBe(99);
    expect(input.amount).toBe(99);
  });

  it('does not roll back a result object mutated by an after handler that then fails', async () => {
    const shared = { total: 1 };
    const failures: HookFailure[] = [];
    const result = await runWithHooks<null, [], { total: number }>({
      method: () => Promise.resolve(shared),
      thisArg: null,
      args: [],
      before: [],
      after: [
        ({ result }) => {
          result.total = 99;
          throw boom;
        },
      ],
      propagateExceptions: false,
      onHandlerError: (failure) => {
        failures.push(failure);
      },
    });
    expect(result).toBe(shared); // the very object the method returned
    expect(shared.total).toBe(99);
    expect(failures).toHaveLength(1);
  });
});

/**
 * A replacement is an object chosen by the handler, so reading it can itself fail or answer
 * differently each time. It is read once, inside the error boundary.
 */
describe('runWithHooks: replacement values are read once, inside the error boundary', () => {
  const getterError = new Error('replacement failed');
  const throwingArgs: BeforeHandler<Args> = () => ({
    get args(): Args {
      throw getterError;
    },
  });
  const throwingResult: AfterHandler<Args, number> = () => ({
    get result(): number {
      throw getterError;
    },
  });

  it('a throwing args getter is a failing before handler: reported, ignored, method runs once', async () => {
    const next = jest.fn<BeforeHandler<Args>>(({ args }) => ({ args: [args[0] + 1, args[1]] }));
    const { calc, failures, run } = setup();
    await expect(run({ before: [throwingArgs, next] })).resolves.toBe(90); // next still ran: 3*3*10
    expect(calc.calls).toEqual([[3, 3]]);
    expect(failures).toEqual([
      { phase: 'before', index: 0, handler: 'throwingArgs', error: getterError },
    ]);
  });

  it('a throwing result getter is a failing after handler: reported, ignored, result kept', async () => {
    const next = jest.fn<AfterHandler<Args, number>>(({ result }) => ({ result: result + 1 }));
    const { calc, failures, run } = setup();
    await expect(run({ after: [throwingResult, next] })).resolves.toBe(61);
    expect(calc.calls).toEqual([[2, 3]]);
    expect(failures).toEqual([
      { phase: 'after', index: 0, handler: 'throwingResult', error: getterError },
    ]);
  });

  it('with propagateExceptions, a throwing args getter propagates and the method never runs', async () => {
    const { calc, failures, run } = setup();
    await expect(run({ propagateExceptions: true, before: [throwingArgs] })).rejects.toBe(
      getterError,
    );
    expect(calc.calls).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('with propagateExceptions, a throwing result getter propagates after the method ran once', async () => {
    const { calc, failures, run } = setup();
    await expect(run({ propagateExceptions: true, after: [throwingResult] })).rejects.toBe(
      getterError,
    );
    expect(calc.calls).toEqual([[2, 3]]);
    expect(failures).toEqual([]);
  });

  it('reads args once: the value that is validated is the value that is applied', async () => {
    let reads = 0;
    const flaky: BeforeHandler<Args> = () => ({
      get args(): Args {
        reads += 1;
        // First read: a valid tuple. Any later read would be garbage the method must never see.
        return reads === 1 ? [5, 5] : ('garbage' as unknown as Args);
      },
    });
    const { calc, failures, run } = setup();
    await expect(run({ before: [flaky] })).resolves.toBe(250);
    expect(reads).toBe(1);
    expect(calc.calls).toEqual([[5, 5]]);
    expect(failures).toEqual([]);
  });

  it('reads args once when the first read is invalid: it is rejected, not retried', async () => {
    let reads = 0;
    const flaky: BeforeHandler<Args> = () => ({
      get args(): Args {
        reads += 1;
        return reads === 1 ? ('garbage' as unknown as Args) : [5, 5];
      },
    });
    const { calc, failures, run } = setup();
    await expect(run({ before: [flaky] })).resolves.toBe(60); // original args
    expect(reads).toBe(1);
    expect(calc.calls).toEqual([[2, 3]]);
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toBeInstanceOf(TypeError);
  });

  it('reads result once, and keeps a replacement with the value undefined', async () => {
    let reads = 0;
    const counting: AfterHandler<Args, number> = () => ({
      get result(): number {
        reads += 1;
        return reads;
      },
    });
    const { run } = setup();
    await expect(run({ after: [counting] })).resolves.toBe(1);
    expect(reads).toBe(1);

    const unset = runWithHooks<null, [], string | undefined>({
      method: () => Promise.resolve('x'),
      thisArg: null,
      args: [],
      before: [],
      after: [
        () => ({
          get result(): undefined {
            return undefined;
          },
        }),
      ],
      propagateExceptions: false,
      onHandlerError: () => undefined,
    });
    await expect(unset).resolves.toBeUndefined();
  });
});

/** Reporting is best effort and must never change what the run does. */
describe('runWithHooks: a reporter that throws', () => {
  const reporterError = new Error('reporter down');
  const brokenReporter = () =>
    jest.fn<(failure: HookFailure) => void>(() => {
      throw reporterError;
    });

  it('an ignored before failure still lets later hooks and the method run exactly once', async () => {
    const reporter = brokenReporter();
    const { calc, run } = setup();
    const result = await run({
      onHandlerError: reporter,
      before: [explode, ({ args }) => ({ args: [args[0] + 1, args[1]] })],
      after: [({ result }) => ({ result: result + 1 })],
    });
    expect(result).toBe(91); // 3*3*10 + 1: the hooks after the failure ran
    expect(calc.calls).toEqual([[3, 3]]);
    expect(reporter).toHaveBeenCalledTimes(1); // not called again for its own failure
    expect(reporter).toHaveBeenCalledWith({
      phase: 'before',
      index: 0,
      handler: 'explode',
      error: boom, // the handler's error, not the reporter's
    });
  });

  it('an ignored after failure still lets later after hooks run', async () => {
    const reporter = brokenReporter();
    const later = jest.fn<AfterHandler<Args, number>>(({ result }) => ({ result: result + 1 }));
    const { calc, run } = setup();
    await expect(run({ onHandlerError: reporter, after: [explode, later] })).resolves.toBe(61);
    expect(later).toHaveBeenCalledTimes(1);
    expect(calc.calls).toEqual([[2, 3]]);
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter.mock.calls[0][0]).toMatchObject({ phase: 'after', error: boom });
  });

  it('with propagateExceptions the original error is rethrown and the reporter is not used', async () => {
    const reporter = brokenReporter();
    const { run } = setup();
    await expect(
      run({ onHandlerError: reporter, propagateExceptions: true, before: [explode] }),
    ).rejects.toBe(boom);
    await expect(
      run({ onHandlerError: reporter, propagateExceptions: true, after: [explode] }),
    ).rejects.toBe(boom);
    expect(reporter).not.toHaveBeenCalled();
  });

  it('does not hide an error of the core method', async () => {
    const coreError = new Error('core failed');
    const reporter = brokenReporter();
    await expect(
      setup().run({
        onHandlerError: reporter,
        before: [explode],
        method: () => Promise.reject(coreError),
      }),
    ).rejects.toBe(coreError);
    expect(reporter).toHaveBeenCalledTimes(1);
  });
});

/**
 * Compile-time checks: verified by `npm run typecheck`, NOT by jest (ts-jest is transpile-only
 * here). An unused `@ts-expect-error` is itself a compile error. Keep each directive's line
 * short so Prettier does not move the error away from it.
 */
describe('runWithHooks: type safety', () => {
  type Equal<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

  it('only accepts replacements of the right shape and type', () => {
    const swap: BeforeHandler<Args> = ({ args }) => ({ args: [args[1], args[0]] });
    const swapAsync: BeforeHandler<Args> = ({ args }) => Promise.resolve({ args });
    // @ts-expect-error wrong element type
    const wrongType: BeforeHandler<Args> = () => ({ args: ['x', 1] });
    // @ts-expect-error wrong tuple length
    const wrongLength: BeforeHandler<Args> = () => ({ args: [1] });
    // @ts-expect-error the tuple itself is not a replacement, it must be wrapped in { args }
    const unwrapped: BeforeHandler<Args> = ({ args }) => args;
    // @ts-expect-error a before handler replaces args, not the result
    const wrongKey: BeforeHandler<Args> = () => ({ result: 1 });

    const double: AfterHandler<Args, number> = ({ result }) => ({ result: result * 2 });
    // @ts-expect-error the result must be a number
    const wrongResult: AfterHandler<Args, number> = () => ({ result: 'x' });
    // @ts-expect-error undefined is not a valid number result
    const noUndefined: AfterHandler<Args, number> = () => ({ result: undefined });
    const allowsUndefined: AfterHandler<Args, number | undefined> = () => ({ result: undefined });
    // @ts-expect-error an after handler replaces the result, not args
    const afterWrongKey: AfterHandler<Args, number> = () => ({ args: [1, 2] });

    expect([
      swap,
      swapAsync,
      wrongType,
      wrongLength,
      unwrapped,
      wrongKey,
      double,
      wrongResult,
      noUndefined,
      allowsUndefined,
      afterWrongKey,
    ]).toHaveLength(11);
  });

  it('keeps the tuple and the result type in the payload', () => {
    const handler: AfterHandler<Args, number> = ({ args, result }) => {
      const first: number = args[0];
      // @ts-expect-error the tuple has two elements
      void args[2];
      // @ts-expect-error the result is a number
      const text: string = result;
      return { result: first + Number(text) };
    };
    expect(handler).toBeInstanceOf(Function);
  });

  it('payloads are read-only objects: assigning to them does not compile', () => {
    const handler: AfterHandler<Args, number> = (payload) => {
      // @ts-expect-error assigning has no effect at runtime, so it is rejected
      payload.result = 1;
      payload.ctx.fine = true; // the context object itself is for writing
      return undefined;
    };
    expect(handler).toBeInstanceOf(Function);
  });

  it('matches the payload types of @ClientHook handlers (BeforeHook / AfterHook)', () => {
    const before: Equal<BeforeHook<Calculator, 'multiply'>, BeforePayload<Args>> = true;
    const after: Equal<AfterHook<Calculator, 'multiply'>, AfterPayload<Args, number>> = true;
    const args: Equal<MethodArgs<Calculator, 'multiply'>, Args> = true;
    const result: Equal<MethodResult<Calculator, 'multiply'>, number> = true;
    // A handler written against the A1 types is usable as a runner handler.
    const fromDecoratorTypes: AfterHandler<Args, number> = (
      payload: AfterHook<Calculator, 'multiply'>,
    ) => ({ result: payload.result });
    expect([before, after, args, result]).toEqual([true, true, true, true]);
    expect(fromDecoratorTypes).toBeInstanceOf(Function);
  });

  it('checks the run itself: the handlers must fit the method', () => {
    const base = { thisArg: null, propagateExceptions: false, onHandlerError: () => undefined };
    const method = (a: number) => Promise.resolve(String(a));
    const ok = runWithHooks({
      ...base,
      method,
      args: [1],
      before: [],
      after: [() => ({ result: 'x' })],
    });
    const bad = runWithHooks({
      ...base,
      method,
      args: [1],
      before: [],
      // @ts-expect-error the result of this method is a string
      after: [() => ({ result: 1 })],
    });
    expect([ok, bad]).toHaveLength(2);
    void Promise.allSettled([ok, bad]);
  });
});
