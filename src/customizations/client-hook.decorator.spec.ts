import { Reflector } from '@nestjs/core';
import { CLIENT_HOOK_KEY, ClientHook, type ClientHookMetadata } from './client-hook.decorator.js';
import type { ArgsReplacement, ResultReplacement } from './hook-runner.js';
// `import type` is required: these interfaces appear in decorated signatures
// (isolatedModules + emitDecoratorMetadata, TS1272).
import type {
  AfterHook,
  BeforeHook,
  CustomizableMethodName,
  HookContext,
  HookPhase,
  MethodArgs,
  MethodResult,
} from './hook.types.js';

interface ConvertInput {
  from: string;
  to: string;
  amountMinor: number;
}
interface Conversion {
  id: string;
  receivedMinor: number;
}

/** Test fixture; has nothing to do with a real conversion service. */
class ConvertService {
  rate = 1;

  convert(input: ConvertInput): Promise<Conversion> {
    return Promise.resolve({ id: '1', receivedMinor: input.amountMinor });
  }

  quote(from: string, to: string, note?: string): Promise<string> {
    return Promise.resolve(`${from}${to}${note ?? ''}`);
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  label(): string {
    return 'sync';
  }

  // Never called: it only has to exist for the type tests.
  private secret(): Promise<void> {
    return Promise.resolve();
  }
}

class OtherService {
  other(): Promise<void> {
    return Promise.resolve();
  }
}

/** `true` only if A and B are exactly the same type. Assigning `true` to `false` fails to compile. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe('@ClientHook metadata', () => {
  const reflector = new Reflector();
  const hooksOf = (handler: (...args: never[]) => unknown) =>
    reflector.get<ClientHookMetadata[]>(CLIENT_HOOK_KEY, handler);

  class Hooks {
    @ClientHook('kvitka', ConvertService, 'convert', 'before')
    beforeConvert(_payload: BeforeHook<ConvertService, 'convert'>): void {}

    @ClientHook('wisla', ConvertService, 'convert', 'after')
    afterConvert(_payload: AfterHook<ConvertService, 'convert'>): void {}

    // Stacked: one handler for two targets (it only uses what both payloads share).
    @ClientHook('demo', ConvertService, 'ping', 'after')
    @ClientHook('kvitka', ConvertService, 'ping', 'before')
    audit(_payload: BeforeHook<ConvertService, 'ping'>): void {}

    notAHook(): void {}
  }

  it('records client, target class, method name and the before phase', () => {
    expect(hooksOf(Hooks.prototype.beforeConvert)).toEqual([
      { client: 'kvitka', target: ConvertService, method: 'convert', phase: 'before' },
    ]);
  });

  it('records client, target class, method name and the after phase', () => {
    expect(hooksOf(Hooks.prototype.afterConvert)).toEqual([
      { client: 'wisla', target: ConvertService, method: 'convert', phase: 'after' },
    ]);
  });

  it('keeps the target as the class itself, so a registrar can match provider instances', () => {
    const [entry] = hooksOf(Hooks.prototype.afterConvert);
    expect(entry.target).toBe(ConvertService);
    expect(new ConvertService()).toBeInstanceOf(entry.target);
  });

  it('adds an entry for every stacked decorator', () => {
    expect(hooksOf(Hooks.prototype.audit)).toEqual([
      { client: 'kvitka', target: ConvertService, method: 'ping', phase: 'before' },
      { client: 'demo', target: ConvertService, method: 'ping', phase: 'after' },
    ]);
  });

  it('leaves other methods untouched and does not wrap the handler', () => {
    expect(hooksOf(Hooks.prototype.notAHook)).toBeUndefined();
    expect(Hooks.prototype.beforeConvert.name).toBe('beforeConvert');
  });

  // Metadata lives on the handler FUNCTION, so it follows the function and nothing else.
  describe('inheritance', () => {
    class BaseHooks {
      @ClientHook('kvitka', ConvertService, 'convert', 'after')
      handle(_payload: AfterHook<ConvertService, 'convert'>): void {}
    }

    class InheritingHooks extends BaseHooks {}

    class OverridingHooks extends BaseHooks {
      override handle(_payload: AfterHook<ConvertService, 'convert'>): void {}
    }

    class RedecoratingHooks extends BaseHooks {
      @ClientHook('wisla', ConvertService, 'convert', 'after')
      override handle(_payload: AfterHook<ConvertService, 'convert'>): void {}
    }

    const base = [{ client: 'kvitka', target: ConvertService, method: 'convert', phase: 'after' }];

    it('an inherited, unchanged handler is the same function and keeps its hook', () => {
      expect(InheritingHooks.prototype.handle).toBe(BaseHooks.prototype.handle);
      expect(hooksOf(InheritingHooks.prototype.handle)).toEqual(base);
    });

    it('an override is a new function: its hook is dropped unless it is decorated again', () => {
      expect(hooksOf(OverridingHooks.prototype.handle)).toBeUndefined();
      expect(hooksOf(BaseHooks.prototype.handle)).toEqual(base);
    });

    it('a decorated override has only its own hooks and leaves the base untouched', () => {
      expect(hooksOf(RedecoratingHooks.prototype.handle)).toEqual([
        { client: 'wisla', target: ConvertService, method: 'convert', phase: 'after' },
      ]);
      expect(hooksOf(BaseHooks.prototype.handle)).toEqual(base);
    });
  });
});

// Everything below is checked by `npm run typecheck`, NOT by jest (ts-jest runs transpile-only
// here). An unused `@ts-expect-error` is itself a compile error, so a negative case that stops
// failing breaks the type check.
describe('@ClientHook compile-time checks', () => {
  it('derives the allowed method names: public async methods only', () => {
    const names: Equal<CustomizableMethodName<ConvertService>, 'convert' | 'quote' | 'ping'> = true;
    expect(names).toBe(true);
  });

  // Documents the known limitation: the filter looks at a member's TYPE, not how it was declared,
  // so an async function-valued field is offered as a method name. It cannot carry
  // `@Customizable()`, so a hook on it must be rejected by the startup validation (a later phase).
  it('also offers an async function-valued field (structural typing cannot tell)', () => {
    class WithField {
      run = (): Promise<void> => Promise.resolve();
    }
    const names: Equal<CustomizableMethodName<WithField>, 'run'> = true;
    expect(names).toBe(true);
    expect(() => ClientHook('kvitka', WithField, 'run', 'after')).not.toThrow();
  });

  it('preserves the argument tuple (names and optionality) and the resolved result', () => {
    const quoteArgs: Equal<
      MethodArgs<ConvertService, 'quote'>,
      [from: string, to: string, note?: string]
    > = true;
    const pingArgs: Equal<MethodArgs<ConvertService, 'ping'>, []> = true;
    const convertResult: Equal<MethodResult<ConvertService, 'convert'>, Conversion> = true;
    const pingResult: Equal<MethodResult<ConvertService, 'ping'>, void> = true;
    expect([quoteArgs, pingArgs, convertResult, pingResult]).toEqual([true, true, true, true]);
  });

  it('gives each phase its payload: before has args and ctx, after adds result', () => {
    const before: Equal<
      BeforeHook<ConvertService, 'convert'>,
      { readonly args: [input: ConvertInput]; readonly ctx: HookContext }
    > = true;
    const afterResult: Equal<AfterHook<ConvertService, 'convert'>['result'], Conversion> = true;
    expect([before, afterResult]).toEqual([true, true]);

    const payload = { args: [], ctx: {} } as unknown as BeforeHook<ConvertService, 'ping'>;
    // @ts-expect-error a before handler has no result yet
    expect(payload.result).toBeUndefined();
  });

  // A handler changes data by returning a replacement (see hook-runner.ts), so assigning to the
  // payload would be silently lost. The properties are readonly (shallow: `ctx.x = 1` and
  // `args[0].from = 'x'` still compile; there is no deep immutability and no rollback).
  it('rejects assignment to payload properties, but not to what they point at', () => {
    const payload = { args: [], ctx: {}, result: undefined } as unknown as AfterHook<
      ConvertService,
      'convert'
    >;
    // @ts-expect-error `args` is readonly
    payload.args = [{ from: 'USD', to: 'UAH', amountMinor: 1 }];
    // @ts-expect-error `result` is readonly
    payload.result = { id: '2', receivedMinor: 1 };
    // @ts-expect-error `ctx` is readonly
    payload.ctx = {};
    expect(() => {
      payload.ctx.key = 'value';
    }).not.toThrow();
  });

  it('accepts correctly typed handlers, including a narrower payload', () => {
    class Accepts {
      @ClientHook('kvitka', ConvertService, 'convert', 'after')
      full({ args, result, ctx }: AfterHook<ConvertService, 'convert'>): Promise<void> {
        const received: number = result.receivedMinor; // typed as Conversion
        const input: ConvertInput = args[0]; // typed as the method's first argument
        ctx.seen = input.from + received;
        return Promise.resolve();
      }

      // A handler may ask for less than it is given.
      @ClientHook('kvitka', ConvertService, 'convert', 'after')
      onlyResult(payload: { result: Conversion }): void {
        void payload;
      }

      // An `after` payload is a superset of a `before` payload, so this is accepted too.
      @ClientHook('kvitka', ConvertService, 'convert', 'after')
      beforeShapedHandler(payload: BeforeHook<ConvertService, 'convert'>): void {
        void payload;
      }

      // A replacement must be wrapped: `{ args }`, not the bare tuple (see the return-value tests).
      @ClientHook('kvitka', ConvertService, 'convert', 'before')
      returnsReplacement(
        payload: BeforeHook<ConvertService, 'convert'>,
      ): ArgsReplacement<[input: ConvertInput]> {
        return { args: payload.args };
      }

      // An extra parameter is fine as long as it is optional: callers may omit it.
      @ClientHook('kvitka', ConvertService, 'convert', 'after')
      optionalExtra(payload: AfterHook<ConvertService, 'convert'>, extra?: string): void {
        void [payload, extra];
      }
    }
    expect(Accepts).toBeDefined();
  });

  it('rejects a nonexistent method, a private one, a synchronous one and a property', () => {
    // @ts-expect-error no such method
    ClientHook('kvitka', ConvertService, 'nope', 'after');
    // @ts-expect-error private methods are not part of the public type
    ClientHook('kvitka', ConvertService, 'secret', 'after');
    // @ts-expect-error a synchronous method cannot be customizable
    ClientHook('kvitka', ConvertService, 'label', 'after');
    // @ts-expect-error a property is not a method
    ClientHook('kvitka', ConvertService, 'rate', 'after');
    // @ts-expect-error a method of ANOTHER class does not exist on this target
    ClientHook('kvitka', OtherService, 'convert', 'after');
  });

  it('rejects invalid targets', () => {
    // @ts-expect-error an instance is not a class
    ClientHook('kvitka', new ConvertService(), 'convert', 'after');
    // @ts-expect-error a string is not a class
    ClientHook('kvitka', 'ConvertService', 'convert', 'after');
    // @ts-expect-error an arrow function is not a constructor
    ClientHook('kvitka', () => new ConvertService(), 'convert', 'after');
    // @ts-expect-error a plain object is not a constructor
    ClientHook('kvitka', { convert: () => Promise.resolve() }, 'convert', 'after');
  });

  it('rejects unknown clients and phases', () => {
    // @ts-expect-error not one of KNOWN_CLIENTS
    ClientHook('acme', ConvertService, 'convert', 'after');
    // @ts-expect-error only 'before' and 'after' exist
    ClientHook('kvitka', ConvertService, 'convert', 'around');
    // @ts-expect-error the phase is required
    ClientHook('kvitka', ConvertService, 'convert');
  });

  it('rejects handlers whose payload does not match the target method and phase', () => {
    class Rejects {
      // @ts-expect-error payload of a different method (ping has no arguments)
      @ClientHook('kvitka', ConvertService, 'convert', 'after')
      wrongMethod(_payload: AfterHook<ConvertService, 'ping'>): void {}

      // @ts-expect-error a before hook has no `result`, so an after-shaped handler cannot take it
      @ClientHook('kvitka', ConvertService, 'convert', 'before')
      wrongPhase(_payload: AfterHook<ConvertService, 'convert'>): void {}

      // @ts-expect-error the handler expects a result of another type
      @ClientHook('kvitka', ConvertService, 'convert', 'after')
      wrongResult(_payload: { result: string }): void {}

      // @ts-expect-error narrower than provided: the method accepts any `from`, not just 'USD'
      @ClientHook('kvitka', ConvertService, 'convert', 'before')
      narrowerArgs(_payload: { args: [input: ConvertInput & { from: 'USD' }] }): void {}

      // @ts-expect-error `ctx` values are `unknown`; a handler may not assume a type for them
      @ClientHook('kvitka', ConvertService, 'convert', 'before')
      narrowerCtx(_payload: { ctx: { seen: boolean } }): void {}

      // @ts-expect-error a required second parameter would never be supplied
      @ClientHook('kvitka', ConvertService, 'convert', 'after')
      extraRequiredParameter(
        _payload: AfterHook<ConvertService, 'convert'>,
        _extra: string,
      ): void {}
    }
    expect(Rejects).toBeDefined();
  });

  it('rejects a property at compile time, and fails clearly at runtime if that is bypassed', () => {
    expect(() => {
      class OnAProperty {
        // @ts-expect-error a handler must be a method, not a property
        @ClientHook('kvitka', ConvertService, 'convert', 'after')
        notAMethod = 1;
      }
      return OnAProperty;
    }).toThrow('@ClientHook() can only decorate a method');
  });

  it('throws on a getter that returns a handler function, which the types accept', () => {
    const seen: { prototype?: object } = {};
    const capture = (target: object, _key: string | symbol, _descriptor: unknown): void => {
      seen.prototype = target;
    };
    expect(() => {
      class OnAGetter {
        @capture
        first(): void {}

        // Type-checks: the getter's TYPE is a function taking the right payload.
        @ClientHook('kvitka', ConvertService, 'convert', 'after')
        get handle(): (payload: AfterHook<ConvertService, 'convert'>) => void {
          return () => undefined;
        }
      }
      return OnAGetter;
    }).toThrow(
      new TypeError(
        '@ClientHook() can only decorate a method, not "handle" (a property or accessor)',
      ),
    );

    const prototype = seen.prototype as object;
    const getter = Object.getOwnPropertyDescriptor(prototype, 'handle')?.get;
    expect(getter).toBeInstanceOf(Function);
    expect(Reflect.hasMetadata(CLIENT_HOOK_KEY, getter as object)).toBe(false);
    expect(Reflect.getMetadataKeys(prototype)).toEqual([]);
  });
});

/**
 * The handler's RETURN value is checked against the runner's contract for the phase: nothing, or
 * `{ args }` (before) / `{ result }` (after), with the target method's own types, plain or in a
 * promise. Negative cases are compile-only: verified by `npm run typecheck`, not by jest (ts-jest
 * is transpile-only here), and kept in a function that is never called.
 */
describe('@ClientHook handler return values', () => {
  /** A result that legitimately includes `undefined`. */
  class Lookup {
    find(id: string): Promise<Conversion | undefined> {
      return Promise.resolve(id ? undefined : { id, receivedMinor: 0 });
    }
  }

  const reflector = new Reflector();
  const hooksOf = (handler: (...args: never[]) => unknown) =>
    reflector.get<ClientHookMetadata[]>(CLIENT_HOOK_KEY, handler);
  const input: ConvertInput = { from: 'USD', to: 'UAH', amountMinor: 100 };
  const conversion: Conversion = { id: '1', receivedMinor: 100 };

  it('accepts a replacement, a promise of one, or none, in either phase', async () => {
    class Valid {
      @ClientHook('kvitka', ConvertService, 'convert', 'before')
      beforeReplaces(p: BeforeHook<ConvertService, 'convert'>): ArgsReplacement<[ConvertInput]> {
        return { args: [{ ...p.args[0], amountMinor: p.args[0].amountMinor + 1 }] };
      }

      @ClientHook('kvitka', ConvertService, 'convert', 'after')
      afterReplaces(p: AfterHook<ConvertService, 'convert'>): ResultReplacement<Conversion> {
        return { result: { ...p.result, receivedMinor: 0 } };
      }

      @ClientHook('kvitka', ConvertService, 'convert', 'after')
      async asyncAfter(p: AfterHook<ConvertService, 'convert'>) {
        await Promise.resolve();
        return { result: p.result };
      }

      @ClientHook('kvitka', ConvertService, 'convert', 'after')
      promisedAfter(
        p: AfterHook<ConvertService, 'convert'>,
      ): Promise<ResultReplacement<Conversion>> {
        return Promise.resolve({ result: p.result });
      }

      // No replacement, written in every way the runner accepts.
      @ClientHook('kvitka', ConvertService, 'convert', 'after')
      returnsNothing(p: AfterHook<ConvertService, 'convert'>): void {
        void p;
      }

      @ClientHook('kvitka', ConvertService, 'convert', 'after')
      returnsUndefined(p: AfterHook<ConvertService, 'convert'>): undefined {
        void p;
        return undefined;
      }

      @ClientHook('kvitka', ConvertService, 'convert', 'before')
      async returnsPromisedNothing(p: BeforeHook<ConvertService, 'convert'>): Promise<void> {
        await Promise.resolve(p);
      }

      // A replacement without a return annotation: fine for an object, not for an array literal.
      @ClientHook('kvitka', ConvertService, 'convert', 'after')
      inferredObject({ result }: AfterHook<ConvertService, 'convert'>) {
        return { result };
      }

      @ClientHook('kvitka', ConvertService, 'convert', 'before')
      annotatedTuple({ args }: BeforeHook<ConvertService, 'convert'>) {
        return { args: [args[0]] as [ConvertInput] };
      }

      // Several arguments, the last optional: all of them, or without the optional one.
      @ClientHook('kvitka', ConvertService, 'quote', 'before')
      allArguments(
        p: BeforeHook<ConvertService, 'quote'>,
      ): ArgsReplacement<[from: string, to: string, note?: string]> {
        return { args: [p.args[1], p.args[0], 'swapped'] };
      }

      @ClientHook('kvitka', ConvertService, 'quote', 'before')
      withoutOptional(p: BeforeHook<ConvertService, 'quote'>): ArgsReplacement<[string, string]> {
        return { args: [p.args[0], p.args[1]] };
      }

      // Where the method's result includes `undefined`, so may the replacement.
      @ClientHook('kvitka', Lookup, 'find', 'after')
      clearsResult(p: AfterHook<Lookup, 'find'>): ResultReplacement<Conversion | undefined> {
        void p;
        return { result: undefined };
      }

      // Explicit type arguments are checked exactly like inferred ones.
      @ClientHook<typeof ConvertService, 'convert', 'after'>(
        'kvitka',
        ConvertService,
        'convert',
        'after',
      )
      explicitTypeArguments(
        p: AfterHook<ConvertService, 'convert'>,
      ): ResultReplacement<Conversion> {
        return { result: p.result };
      }
    }

    const valid = new Valid();
    expect(valid.beforeReplaces({ args: [input], ctx: {} })).toEqual({
      args: [{ ...input, amountMinor: 101 }],
    });
    expect(await valid.asyncAfter({ args: [input], result: conversion, ctx: {} })).toEqual({
      result: conversion,
    });
    expect(valid.allArguments({ args: ['USD', 'UAH'], ctx: {} })).toEqual({
      args: ['UAH', 'USD', 'swapped'],
    });
    // Each decorator registered its entry, for the method and the phase it names.
    expect(hooksOf(Valid.prototype.clearsResult)).toEqual([
      { client: 'kvitka', target: Lookup, method: 'find', phase: 'after' },
    ]);
    expect(hooksOf(Valid.prototype.explicitTypeArguments)).toHaveLength(1);
  });

  it('rejects an argument replacement that does not fit the method', () => {
    const invalid = (): unknown[] => {
      class WrongArguments {
        // @ts-expect-error the method takes a ConvertInput, not a string
        @ClientHook('kvitka', ConvertService, 'convert', 'before')
        wrongType(p: BeforeHook<ConvertService, 'convert'>): ArgsReplacement<[string]> {
          return { args: [p.args[0].from] };
        }

        // @ts-expect-error a required argument is missing
        @ClientHook('kvitka', ConvertService, 'quote', 'before')
        missingRequired(p: BeforeHook<ConvertService, 'quote'>): ArgsReplacement<[string]> {
          return { args: [p.args[0]] };
        }

        // @ts-expect-error the arguments are in the wrong order
        @ClientHook('kvitka', ConvertService, 'quote', 'before')
        wrongOrder(p: BeforeHook<ConvertService, 'quote'>): ArgsReplacement<[number, string]> {
          return { args: [1, p.args[0]] };
        }

        // @ts-expect-error `convert` takes one argument, not two
        @ClientHook('kvitka', ConvertService, 'convert', 'before')
        tooMany(p: BeforeHook<ConvertService, 'convert'>): ArgsReplacement<[ConvertInput, number]> {
          return { args: [p.args[0], 1] };
        }

        // @ts-expect-error an array literal is inferred as ConvertInput[], not as the tuple
        @ClientHook('kvitka', ConvertService, 'convert', 'before')
        unannotatedArray({ args }: BeforeHook<ConvertService, 'convert'>) {
          return { args: [args[0]] };
        }
      }
      return [WrongArguments];
    };
    expect(invalid).toBeInstanceOf(Function);
  });

  it('rejects a result replacement that does not fit the method', () => {
    const invalid = (): unknown[] => {
      class WrongResults {
        // @ts-expect-error the result is a Conversion, not a string
        @ClientHook('kvitka', ConvertService, 'convert', 'after')
        wrongType(p: AfterHook<ConvertService, 'convert'>): ResultReplacement<string> {
          return { result: p.result.id };
        }

        // @ts-expect-error `convert` never resolves to undefined
        @ClientHook('kvitka', ConvertService, 'convert', 'after')
        undefinedNotAllowed(p: AfterHook<ConvertService, 'convert'>): ResultReplacement<undefined> {
          void p;
          return { result: undefined };
        }

        // @ts-expect-error `null` is not `undefined`, even where undefined is allowed
        @ClientHook('kvitka', Lookup, 'find', 'after')
        nullNotAllowed(p: AfterHook<Lookup, 'find'>): ResultReplacement<Conversion | null> {
          void p;
          return { result: null };
        }

        // @ts-expect-error the wrong type is rejected inside a promise as well
        @ClientHook('kvitka', ConvertService, 'convert', 'after')
        promisedWrongType(
          p: AfterHook<ConvertService, 'convert'>,
        ): Promise<ResultReplacement<string>> {
          return Promise.resolve({ result: p.result.id });
        }

        // @ts-expect-error explicit type arguments do not loosen the check
        @ClientHook<typeof ConvertService, 'convert', 'after'>(
          'kvitka',
          ConvertService,
          'convert',
          'after',
        )
        explicitWrongType(p: AfterHook<ConvertService, 'convert'>): ResultReplacement<string> {
          return { result: p.result.id };
        }
      }
      return [WrongResults];
    };
    expect(invalid).toBeInstanceOf(Function);
  });

  it('rejects anything that is not exactly a replacement, or nothing', () => {
    const invalid = (): unknown[] => {
      class WrongShapes {
        // @ts-expect-error the bare tuple is not a replacement, it must be wrapped in { args }
        @ClientHook('kvitka', ConvertService, 'convert', 'before')
        bareTuple(p: BeforeHook<ConvertService, 'convert'>): [ConvertInput] {
          return p.args;
        }

        // @ts-expect-error the bare result is not a replacement, it must be wrapped in { result }
        @ClientHook('kvitka', ConvertService, 'convert', 'after')
        bareResult(p: AfterHook<ConvertService, 'convert'>): Conversion {
          return p.result;
        }

        // @ts-expect-error a before handler replaces args, not the result
        @ClientHook('kvitka', ConvertService, 'convert', 'before')
        resultFromBefore(p: BeforeHook<ConvertService, 'convert'>): ResultReplacement<Conversion> {
          void p;
          return { result: conversion };
        }

        // @ts-expect-error an after handler replaces the result, not args
        @ClientHook('kvitka', ConvertService, 'convert', 'after')
        argsFromAfter(p: AfterHook<ConvertService, 'convert'>): ArgsReplacement<[ConvertInput]> {
          return { args: p.args };
        }

        // @ts-expect-error an unrelated object
        @ClientHook('kvitka', ConvertService, 'convert', 'after')
        unrelatedObject(p: AfterHook<ConvertService, 'convert'>): { results: Conversion } {
          return { results: p.result };
        }

        // @ts-expect-error a primitive
        @ClientHook('kvitka', ConvertService, 'convert', 'after')
        aNumber(p: AfterHook<ConvertService, 'convert'>): number {
          void p;
          return 1;
        }

        // @ts-expect-error null is not "no replacement"; return nothing or undefined
        @ClientHook('kvitka', ConvertService, 'convert', 'after')
        aNull(p: AfterHook<ConvertService, 'convert'>): null {
          void p;
          return null;
        }

        // @ts-expect-error inferred bare result
        @ClientHook('kvitka', ConvertService, 'convert', 'after')
        inferredBareResult(p: AfterHook<ConvertService, 'convert'>) {
          return p.result;
        }

        // @ts-expect-error inferred bare tuple
        @ClientHook('kvitka', ConvertService, 'convert', 'before')
        inferredBareTuple({ args }: BeforeHook<ConvertService, 'convert'>) {
          return args;
        }
      }
      return [WrongShapes];
    };
    expect(invalid).toBeInstanceOf(Function);
  });

  it('keeps the method and phase checks that were already in place', () => {
    const invalid = (): unknown[] => {
      class WrongTargets {
        // @ts-expect-error no such method
        @ClientHook('kvitka', ConvertService, 'nope', 'after')
        noSuchMethod(p: AfterHook<ConvertService, 'convert'>): void {
          void p;
        }

        // @ts-expect-error only 'before' and 'after' exist
        @ClientHook('kvitka', ConvertService, 'convert', 'around')
        noSuchPhase(p: AfterHook<ConvertService, 'convert'>): void {
          void p;
        }

        // @ts-expect-error not a known client
        @ClientHook('acme', ConvertService, 'convert', 'after')
        noSuchClient(p: AfterHook<ConvertService, 'convert'>): void {
          void p;
        }

        // @ts-expect-error the payload belongs to another method
        @ClientHook('kvitka', ConvertService, 'convert', 'after')
        wrongPayload(p: AfterHook<ConvertService, 'ping'>): void {
          void p;
        }
      }
      return [WrongTargets];
    };
    expect(invalid).toBeInstanceOf(Function);
  });
});

/**
 * With a union as `target`, `method` or `phase`, the handler would only be checked against the
 * UNION of the possible handler types, so one that is right for a single member would be accepted.
 * `@ClientHook` therefore asks for one value of each (`SingleOnly`, shared with `HookRegistry`).
 * Literals, as normally written at a decorator site, are unaffected; a union has to be narrowed
 * first. Note that TypeScript does not carry flow-narrowing INTO a decorator expression, so the
 * narrowed value is copied into a `const` and that is passed on (`const narrowed = phase`).
 *
 * Negative cases are compile-only (checked by `npm run typecheck`, not by jest), in functions that
 * are never called. They use a handler that fits every phase and method, so that only the union
 * itself can make a decoration invalid.
 */
describe('@ClientHook union keys', () => {
  /** `run` returns a number, `text` a string: that difference is what a union would blur. */
  class Numbers {
    run(n: number): Promise<number> {
      return Promise.resolve(n);
    }

    text(s: string): Promise<string> {
      return Promise.resolve(s);
    }
  }
  class Strings {
    run(n: number): Promise<string> {
      return Promise.resolve(String(n));
    }
  }

  type Either = typeof Numbers | typeof Strings;

  /** Fits any phase, method and target: only the union can make a decoration invalid. */
  interface AnyPayload {
    readonly ctx: HookContext;
  }

  const reflector = new Reflector();
  const hooksOf = (handler: (...args: never[]) => unknown) =>
    reflector.get<ClientHookMetadata[] | undefined>(CLIENT_HOOK_KEY, handler);

  it('rejects a union phase, whatever the handler returns', () => {
    const invalid = (phase: HookPhase): unknown[] => {
      class UnionPhase {
        // @ts-expect-error `phase` may be 'before', where an after handler gets no `result`
        @ClientHook('kvitka', Numbers, 'run', phase)
        afterOnly(p: AfterHook<Numbers, 'run'>): ResultReplacement<number> {
          return { result: p.result };
        }

        // @ts-expect-error `phase` may be 'after', where a before handler is not run
        @ClientHook('kvitka', Numbers, 'run', phase)
        beforeOnly(p: BeforeHook<Numbers, 'run'>): ArgsReplacement<[n: number]> {
          return { args: p.args };
        }

        // @ts-expect-error even a handler that fits both phases is not accepted
        @ClientHook('kvitka', Numbers, 'run', phase)
        fitsBoth(p: AnyPayload): void {
          void p;
        }
      }
      return [UnionPhase];
    };
    expect(invalid).toBeInstanceOf(Function);
  });

  it('rejects a union method with different arguments or results', () => {
    const invalid = (method: 'run' | 'text'): unknown[] => {
      class UnionMethod {
        // @ts-expect-error `run` resolves to a number, `text` to a string
        @ClientHook('kvitka', Numbers, method, 'after')
        stringResult(p: AnyPayload): ResultReplacement<string> {
          void p;
          return { result: 'wrong for run' };
        }

        // @ts-expect-error `run` takes a number, `text` a string
        @ClientHook('kvitka', Numbers, method, 'before')
        stringArgs(p: AnyPayload): ArgsReplacement<[string]> {
          void p;
          return { args: ['wrong for run'] };
        }

        // @ts-expect-error even a handler that fits every method is not accepted
        @ClientHook('kvitka', Numbers, method, 'after')
        fitsEvery(p: AnyPayload): void {
          void p;
        }
      }
      return [UnionMethod];
    };
    expect(invalid).toBeInstanceOf(Function);
  });

  it('rejects a union of target classes with incompatible methods', () => {
    const invalid = (target: typeof Numbers | typeof Strings): unknown[] => {
      class UnionTarget {
        // @ts-expect-error `Numbers.run` resolves to a number, `Strings.run` to a string
        @ClientHook('kvitka', target, 'run', 'after')
        stringResult(p: AnyPayload): ResultReplacement<string> {
          void p;
          return { result: 'wrong for Numbers' };
        }

        // @ts-expect-error even a handler that fits both classes is not accepted
        @ClientHook('kvitka', target, 'run', 'after')
        fitsBoth(p: AnyPayload): void {
          void p;
        }
      }
      return [UnionTarget];
    };
    expect(invalid).toBeInstanceOf(Function);
  });

  it('rejects a union written out as explicit type arguments', () => {
    const invalid = (): unknown[] => {
      class ExplicitUnions {
        // @ts-expect-error explicit union of methods
        @ClientHook<typeof Numbers, 'run' | 'text', 'after'>('kvitka', Numbers, 'run', 'after')
        method(p: AnyPayload): void {
          void p;
        }

        // @ts-expect-error explicit union of phases
        @ClientHook<typeof Numbers, 'run', HookPhase>('kvitka', Numbers, 'run', 'after')
        phase(p: AnyPayload): void {
          void p;
        }

        // @ts-expect-error explicit union of targets
        @ClientHook<Either, 'run', 'after'>('kvitka', Numbers, 'run', 'after')
        target(p: AnyPayload): void {
          void p;
        }
      }
      return [ExplicitUnions];
    };
    expect(invalid).toBeInstanceOf(Function);
  });

  it('rejects generic wrapper keys, because they may stand for the whole union', () => {
    const invalid = <
      P extends HookPhase,
      M extends 'run' | 'text',
      T extends typeof Numbers | typeof Strings,
    >(
      phase: P,
      method: M,
      target: T,
    ): unknown[] => {
      class Generic {
        // @ts-expect-error `P` could be both phases
        @ClientHook('kvitka', Numbers, 'run', phase)
        genericPhase(p: AnyPayload): void {
          void p;
        }

        // @ts-expect-error `M` could be both methods
        @ClientHook('kvitka', Numbers, method, 'after')
        genericMethod(p: AnyPayload): void {
          void p;
        }

        // @ts-expect-error `T` could be both classes
        @ClientHook('kvitka', target, 'run', 'after')
        genericTarget(p: AnyPayload): void {
          void p;
        }
      }
      return [Generic];
    };
    expect(invalid).toBeInstanceOf(Function);
  });

  it('still rejects the wrong handler under a narrowed key (narrowing does not disable checks)', () => {
    const invalid = (phase: HookPhase): unknown[] => {
      if (phase !== 'before') return [];
      const narrowed = phase; // type 'before'
      class WrongForNarrowed {
        // @ts-expect-error an after handler under 'before'
        @ClientHook('kvitka', Numbers, 'run', narrowed)
        afterHandler(p: AfterHook<Numbers, 'run'>): void {
          void p;
        }
      }
      return [WrongForNarrowed];
    };
    expect(invalid).toBeInstanceOf(Function);
  });

  describe('narrowing a union first works', () => {
    it('narrows a phase', () => {
      const decorate = (phase: HookPhase) => {
        if (phase !== 'after') return undefined;
        const narrowed = phase; // type 'after'
        class Narrowed {
          @ClientHook('kvitka', Numbers, 'run', narrowed)
          handler(p: AfterHook<Numbers, 'run'>): ResultReplacement<number> {
            return { result: p.result + 1 };
          }
        }
        return hooksOf(Narrowed.prototype.handler);
      };
      expect(decorate('before')).toBeUndefined();
      expect(decorate('after')).toEqual([
        { client: 'kvitka', target: Numbers, method: 'run', phase: 'after' },
      ]);
    });

    it('narrows a method, and the handler is then typed by that method', () => {
      const decorate = (method: 'run' | 'text') => {
        if (method !== 'text') return undefined;
        const narrowed = method; // type 'text'
        class Narrowed {
          // `result` is a string here, not `number | string`: the narrowed method decides.
          @ClientHook('kvitka', Numbers, narrowed, 'after')
          async handler(p: AfterHook<Numbers, 'text'>): Promise<ResultReplacement<string>> {
            await Promise.resolve();
            return { result: p.result.trim() };
          }
        }
        return hooksOf(Narrowed.prototype.handler);
      };
      expect(decorate('run')).toBeUndefined();
      expect(decorate('text')).toEqual([
        { client: 'kvitka', target: Numbers, method: 'text', phase: 'after' },
      ]);
    });

    it('narrows a target class', () => {
      const isNumbers = (t: typeof Numbers | typeof Strings): t is typeof Numbers => t === Numbers;
      const decorate = (target: typeof Numbers | typeof Strings) => {
        if (!isNumbers(target)) return undefined;
        const narrowed = target; // typeof Numbers
        class Narrowed {
          @ClientHook('kvitka', narrowed, 'run', 'before')
          handler(p: BeforeHook<Numbers, 'run'>): ArgsReplacement<[n: number]> {
            return { args: [p.args[0] + 1] };
          }
        }
        return hooksOf(Narrowed.prototype.handler);
      };
      expect(decorate(Strings)).toBeUndefined();
      expect(decorate(Numbers)).toEqual([
        { client: 'kvitka', target: Numbers, method: 'run', phase: 'before' },
      ]);
    });

    it('still accepts literals, with sync and async handlers and valid replacements', async () => {
      class Literals {
        @ClientHook('kvitka', Numbers, 'run', 'before')
        syncBefore(p: BeforeHook<Numbers, 'run'>): ArgsReplacement<[n: number]> {
          return { args: [p.args[0] * 2] };
        }

        @ClientHook('kvitka', Numbers, 'run', 'after')
        async asyncAfter(p: AfterHook<Numbers, 'run'>): Promise<ResultReplacement<number>> {
          await Promise.resolve();
          return { result: p.result + 1 };
        }

        @ClientHook('kvitka', Strings, 'run', 'after')
        otherClass(p: AfterHook<Strings, 'run'>): ResultReplacement<string> {
          return { result: p.result + '!' };
        }

        @ClientHook<typeof Numbers, 'text', 'before'>('kvitka', Numbers, 'text', 'before')
        explicitSingleTypeArguments(p: BeforeHook<Numbers, 'text'>): void {
          void p;
        }
      }
      const literals = new Literals();
      expect(literals.syncBefore({ args: [2], ctx: {} })).toEqual({ args: [4] });
      await expect(literals.asyncAfter({ args: [2], result: 5, ctx: {} })).resolves.toEqual({
        result: 6,
      });
      expect(hooksOf(Literals.prototype.otherClass)).toEqual([
        { client: 'kvitka', target: Strings, method: 'run', phase: 'after' },
      ]);
      expect(hooksOf(Literals.prototype.explicitSingleTypeArguments)).toHaveLength(1);
    });
  });
});
