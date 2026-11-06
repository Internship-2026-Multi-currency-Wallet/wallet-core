/**
 * The pure hook runner (E1-3): runs `before` handlers -> the original method -> `after` handlers
 * for ONE call. It knows nothing about NestJS, decorators, metadata or clients: whoever calls it
 * (the method wrapper of a later phase) supplies the method, its arguments and the handlers.
 *
 * Handler contract: a handler changes data only by RETURNING a replacement.
 *   before: `{ args: [...] }`    after: `{ result: ... }`    nothing (`undefined`): keep as is
 * The replacement is recognised by the PRESENCE of the key, so `{ result: undefined }` really
 * replaces the result with `undefined`. Any other return value is a bug in the handler and is
 * treated like a thrown error (see below).
 *
 * What is NOT promised:
 * - No copies. Handlers get the same `args` array and result object as the core code, so a handler
 *   that mutates them in place changes what later steps see, even if it throws afterwards.
 *   There is no rollback. Prefer returning a replacement.
 * - Assigning to the payload (`payload.result = x`) has no effect; the payload types are `readonly`.
 */
import type { HookContext, HookPhase } from './hook.types.js';

/** What a `before` handler receives. Structurally the same as `BeforeHook<Service, 'method'>`. */
export interface BeforePayload<TArgs extends unknown[]> {
  readonly args: TArgs;
  readonly ctx: HookContext;
}

/** What an `after` handler receives. Structurally the same as `AfterHook<Service, 'method'>`. */
export interface AfterPayload<TArgs extends unknown[], TResult> extends BeforePayload<TArgs> {
  readonly result: TResult;
}

export interface ArgsReplacement<TArgs extends unknown[]> {
  args: TArgs;
}

export interface ResultReplacement<TResult> {
  result: TResult;
}

export type BeforeHandler<TArgs extends unknown[]> = (
  payload: BeforePayload<TArgs>,
) => ArgsReplacement<TArgs> | void | Promise<ArgsReplacement<TArgs> | void>;

export type AfterHandler<TArgs extends unknown[], TResult> = (
  payload: AfterPayload<TArgs, TResult>,
) => ResultReplacement<TResult> | void | Promise<ResultReplacement<TResult> | void>;

/** Reported to `onHandlerError` when a handler fails and `propagateExceptions` is off. */
export interface HookFailure {
  phase: HookPhase;
  /** Position of the handler in the list of its phase. */
  index: number;
  /** The handler function's name (empty names are reported as `(anonymous)`). */
  handler: string;
  error: unknown;
}

export interface HookErrorPolicy {
  /** Rethrow a failing handler's error and stop, instead of reporting it and carrying on. */
  propagateExceptions: boolean;
  /**
   * Called synchronously for every ignored handler failure (the future caller logs it). Best
   * effort: if it throws, that error is dropped; it neither stops the run nor is reported again.
   */
  onHandlerError: (failure: HookFailure) => void;
}

/** Everything one invocation needs. The runner discovers and stores nothing itself. */
export interface HookRun<TThis, TArgs extends unknown[], TResult> extends HookErrorPolicy {
  /** The original method. It is called exactly once, with `this` set to `thisArg`. */
  method: (this: TThis, ...args: TArgs) => Promise<TResult>;
  thisArg: TThis;
  args: TArgs;
  /** Run in this order, one after the other. */
  before: readonly BeforeHandler<TArgs>[];
  after: readonly AfterHandler<TArgs, TResult>[];
}

/**
 * Runs one call. Errors:
 * - the core method throws: its error propagates unchanged and no `after` handler runs;
 * - a handler fails (throws, rejects or returns a malformed value): with `propagateExceptions` the
 *   error propagates at once (a failing `before` means the method never runs; a failing `after`
 *   comes too late to undo the method); otherwise `onHandlerError` is called and the run
 *   continues with the last accepted args / result.
 */
export async function runWithHooks<TThis, TArgs extends unknown[], TResult>(
  run: HookRun<TThis, TArgs, TResult>,
): Promise<TResult> {
  // A new object per call, held only in this stack frame: concurrent calls cannot see each other's.
  const ctx: HookContext = {};
  // The lists are copied so a call uses the handlers it started with, even if they change meanwhile.
  const before = [...run.before];
  const after = [...run.after];
  let args = run.args;

  for (const [index, handler] of before.entries()) {
    const replacement = await guarded(run, 'before', index, handler, async () => {
      const returned = await handler({ args, ctx });
      if (returned === undefined) return undefined;
      // Handlers are type-erased when a registrar collects them, so check what really came back.
      // A non-array would otherwise make the CORE call fail, blaming the method for a hook bug.
      if (!hasKey(returned, 'args')) {
        throw new TypeError('a before handler must return undefined or { args: [...] }');
      }
      // Read the property ONCE, here inside the error boundary (it may be a getter that throws or
      // answers differently each time), and hand on a fresh envelope: what is validated is exactly
      // what is applied, and the handler's own object is never touched again.
      const value = returned.args;
      if (!Array.isArray(value)) {
        throw new TypeError('a before handler must return undefined or { args: [...] }');
      }
      return { args: value };
    });
    if (replacement) args = replacement.args;
  }

  // Outside `guarded`: an error of the core method is never hidden or altered.
  // The one type assertion: `await` types a generic `Promise<TResult>` as `Awaited<TResult>`, since
  // TypeScript cannot rule out that `TResult` is itself a thenable. Here it never is: callers pass
  // the RESOLVED type (`MethodResult`), for which `Awaited<TResult>` is `TResult`.
  let result = (await run.method.apply(run.thisArg, args)) as TResult;

  for (const [index, handler] of after.entries()) {
    const replacement = await guarded(run, 'after', index, handler, async () => {
      const returned = await handler({ args, result, ctx });
      if (returned === undefined) return undefined;
      if (!hasKey(returned, 'result')) {
        throw new TypeError('an after handler must return undefined or { result: ... }');
      }
      // Read once inside the boundary, as for `args`. The envelope keeps the key even when the value
      // is `undefined`, so `{ result: undefined }` still replaces the result.
      const value = returned.result;
      return { result: value };
    });
    if (replacement) result = replacement.result;
  }

  return result;
}

/** Applies the error policy to one handler call; `undefined` means "no replacement". */
async function guarded<T>(
  policy: HookErrorPolicy,
  phase: HookPhase,
  index: number,
  handler: (...args: never[]) => unknown,
  call: () => Promise<T | undefined>,
): Promise<T | undefined> {
  try {
    return await call();
  } catch (error) {
    if (policy.propagateExceptions) throw error;
    // Reporting is best effort: a broken reporter must neither replace the handler's error with its
    // own nor stop the run. Its error is dropped, deliberately not reported again (no recursion).
    try {
      policy.onHandlerError({ phase, index, handler: handler.name || '(anonymous)', error });
    } catch {
      // ignored on purpose
    }
    return undefined;
  }
}

/** Presence check (`in`), not a value check: `{ result: undefined }` has the key `result`. */
function hasKey<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return typeof value === 'object' && value !== null && key in value;
}
