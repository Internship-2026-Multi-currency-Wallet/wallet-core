/**
 * Type contracts of the customization system (E1-3). Types only: nothing here runs.
 *
 * A *service* is the instance type of a core class (`ConversionService`); a *method* is the name of
 * one of its public async methods (`'execute'`). Everything below is derived from those two, so a
 * hook can never disagree with the method it targets.
 */

/** The two moments a hook can run in, relative to the customizable method. */
export const HOOK_PHASES = ['before', 'after'] as const;
export type HookPhase = (typeof HOOK_PHASES)[number];

/**
 * Scratch space shared by the `before` and `after` handlers of ONE invocation. Values are
 * `unknown`, so a handler must narrow what it reads. It is an interface (not a type alias) so it
 * can later be augmented with typed keys via declaration merging.
 */
export interface HookContext {
  [key: string]: unknown;
}

/**
 * Any async method. Parameters are `never[]` (not `any[]`): every parameter list is assignable to
 * it, yet nothing typed `any` leaks into the derived types.
 */
export type AsyncMethod = (...args: never[]) => Promise<unknown>;

/** Any class constructor, including abstract ones; the value you pass to `@ClientHook`. */
export type HookTarget = abstract new (...args: never[]) => object;

/**
 * Names of the public members of `TService` that are async functions. `keyof` already leaves out
 * private and protected members; the conditional drops non-function properties and synchronous
 * methods; `& string` drops symbol keys.
 *
 * LIMITATION: this is a structural check on the member's TYPE, and a type does not record how a
 * member was declared. So an async function-valued field (`run = async () => {}`) or a getter
 * returning an async function also appears in this union, although neither can carry
 * `@Customizable()` (a property decorator has no method to mark). Telling them apart would need
 * type-level tricks that are not worth the complexity. Instead such a target is rejected at runtime:
 * `@Customizable()` throws if applied to a field or accessor, and the startup check of a future hook
 * registrar must fail on a hook whose target method has no `@Customizable()` metadata.
 */
export type CustomizableMethodName<TService> = {
  [K in keyof TService]-?: TService[K] extends AsyncMethod ? K : never;
}[keyof TService] &
  string;

/** The method itself, as a type. `Extract` is how we tell TypeScript it is callable. */
type MethodOf<TService, TMethod extends CustomizableMethodName<TService>> = Extract<
  TService[TMethod],
  AsyncMethod
>;

/** The argument tuple of the method, with parameter names and optionality preserved. */
export type MethodArgs<TService, TMethod extends CustomizableMethodName<TService>> = Parameters<
  MethodOf<TService, TMethod>
>;

/** What the method's promise resolves to (`Promise<Conversion>` -> `Conversion`). */
export type MethodResult<TService, TMethod extends CustomizableMethodName<TService>> = Awaited<
  ReturnType<MethodOf<TService, TMethod>>
>;

/**
 * What a `before` handler receives.
 *
 * A handler changes data by RETURNING a replacement (`{ args }` / `{ result }`, see
 * `hook-runner.ts`); the payload object is rebuilt for every handler call, so assigning to its
 * properties would be silently lost. That is why the properties are `readonly`: the compiler
 * rejects `payload.result = x`. The modifier is shallow, on purpose: `args[0].amount = 1` still
 * compiles and still changes the caller's object, with no rollback. `ctx` is the shared scratch
 * space; write to it (`ctx.key = value`).
 */
export interface BeforeHook<TService, TMethod extends CustomizableMethodName<TService>> {
  readonly args: MethodArgs<TService, TMethod>;
  readonly ctx: HookContext;
}

/** What an `after` handler receives: everything a `before` handler gets, plus the result. */
export interface AfterHook<
  TService,
  TMethod extends CustomizableMethodName<TService>,
> extends BeforeHook<TService, TMethod> {
  readonly result: MethodResult<TService, TMethod>;
}

/** The payload for a given phase: `HookPayload<S, 'execute', 'after'>` is `AfterHook<S, 'execute'>`. */
export type HookPayload<
  TService,
  TMethod extends CustomizableMethodName<TService>,
  TPhase extends HookPhase,
> = TPhase extends 'before' ? BeforeHook<TService, TMethod> : AfterHook<TService, TMethod>;

/** `true` if `T` is a union of two or more types (`never` stays `never`, so test it as a tuple). */
export type IsUnion<T, All = T> = T extends unknown ? ([All] extends [T] ? false : true) : never;

/**
 * Intersected with a key parameter (`method: TMethod & SingleOnly<TMethod>`): a single value passes
 * through unchanged (`X & unknown` is `X`), a union becomes an unsatisfiable type, so the call does
 * not compile and the message says why.
 *
 * Why unions must be rejected: with `method: 'a' | 'b'`, `phase: 'before' | 'after'` or a union of
 * target classes, the compiler checks the handler against the UNION of the possible handler types,
 * which loses the link between key and handler. A handler that is only right for `'a'`, only for
 * `'after'`, or only for one of the classes, is accepted although the code may run with another
 * value. TypeScript cannot express "the handler type that goes with whichever key this is" for a
 * caller that holds a union, so the caller must narrow first (`if (phase === 'after') { ... }`).
 *
 * Used by `HookRegistry.register` and `@ClientHook`. A generic parameter whose value is not known
 * to be a single key (`<P extends HookPhase>`) does not pass either.
 */
export type SingleOnly<T> = [IsUnion<T>] extends [false]
  ? unknown
  : { 'must be one single value: narrow any union to one value first': never };
