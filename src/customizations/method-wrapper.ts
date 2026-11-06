/**
 * Connects a customizable method to its registered hooks (E1-3, B2.2): replaces ONE method of ONE
 * provider instance with a function that runs `before` handlers -> the original method -> `after`
 * handlers through `runWithHooks`. All sequencing, replacement and error rules are the runner's;
 * all storage is the registry's. This file only decides WHAT is wrapped and installs the result.
 *
 * Two steps, so that a later activator can validate everything before touching any provider:
 *   - `checkWrappable`: inspects, changes nothing;
 *   - `wrapMethod`: inspects again (the state may have changed) and installs.
 * Neither logs or reports anything itself. Failures of hook handlers go to the `onHandlerError`
 * the caller supplies, nothing else; the wrapper never looks at arguments, results, `ctx` or errors.
 *
 * The wrapper is an OWN property of the instance. The class prototype is never written, so other
 * instances (of this or any class, in this or another application) are not affected.
 */
import 'reflect-metadata';
import { nameOf, prototypeOf } from './checked-hook.js';
import { CUSTOMIZABLE_KEY } from './customizable.decorator.js';
import type { HookRegistry } from './hook-registry.js';
import { type HookErrorPolicy, runWithHooks } from './hook-runner.js';
import type { HookTarget } from './hook.types.js';

/** Marks a function made by `wrapMethod`; the value is the original method it calls. */
const WRAPPED_KEY = 'customizations:wrappedMethod';

/** A method with its argument and result types erased, as the runner calls it. */
type ErasedMethod = (this: unknown, ...args: unknown[]) => Promise<unknown>;

export type WrapProblemCode =
  | 'invalid-instance'
  | 'invalid-target'
  | 'invalid-method-name'
  | 'method-not-found'
  | 'method-is-accessor'
  | 'method-not-function'
  | 'not-customizable'
  | 'method-replaced'
  | 'already-wrapped'
  | 'not-extensible'
  | 'install-failed';

/** Why a method cannot be wrapped. `message` starts with `Target.method`; it holds no values. */
export interface WrapProblem {
  readonly code: WrapProblemCode;
  readonly message: string;
}

/** Only the first problem is reported: each check depends on the previous one passing. */
export type WrapResult =
  { readonly ok: true } | { readonly ok: false; readonly problem: WrapProblem };

export interface WrapOptions {
  readonly registry: HookRegistry;
  /** Called for every handler failure that is not rethrown. Reporting is the caller's business. */
  readonly onHandlerError: HookErrorPolicy['onHandlerError'];
}

/**
 * Dry run of `wrapMethod`: can `instance`'s `method` be wrapped as the one DECLARED by `target`?
 * Changes nothing. Matching is exact, like the registry's: the method the instance would run must
 * be the very function `target` declares (with `@Customizable()`), not an override, not an own
 * property, not another class's. Hooks of `target` are not meant for those.
 */
export function checkWrappable(instance: unknown, target: HookTarget, method: string): WrapResult {
  const found = inspect(instance, target, method);
  return found.ok ? { ok: true } : found;
}

/**
 * Wraps `method` on `instance` (see the file comment). Handlers are read from `options.registry`
 * on every call, so hooks registered after wrapping apply from the next call on. Installing twice
 * on the same instance is refused (`already-wrapped`), whichever registry is used.
 *
 * `this` is whatever the caller of the wrapped method passes (exactly as for the original), and the
 * original is the function captured here, not looked up again. The wrapped method always returns a
 * promise, which `@Customizable()` already requires of the original. `propagateExceptions` is the
 * value in the original's `@Customizable()` metadata, read once now.
 *
 * Does not throw for a method that cannot be wrapped, nor if installing fails (`install-failed`,
 * which only an exotic object such as a proxy can cause): that is the returned problem. Nothing is
 * changed on failure.
 */
export function wrapMethod(
  instance: unknown,
  target: HookTarget,
  method: string,
  options: WrapOptions,
): WrapResult {
  const found = inspect(instance, target, method);
  if (!found.ok) return found;

  const { original, propagateExceptions } = found;
  const { registry, onHandlerError } = options;
  const wrapper = function (this: unknown, ...args: unknown[]): Promise<unknown> {
    const { before, after } = registry.erasedHandlersFor(target, method);
    return runWithHooks({
      method: original,
      thisArg: this,
      args,
      before,
      after,
      propagateExceptions,
      onHandlerError,
    });
  };
  Reflect.defineMetadata(WRAPPED_KEY, original, wrapper);
  // `defineProperty`, not assignment: it also works when the inherited method is read-only. Not
  // enumerable, like a class method, so listing the instance's keys looks the same as before.
  try {
    Object.defineProperty(found.owner, method, {
      value: wrapper,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch {
    // Not expected after a successful inspection (only an exotic object, e.g. a proxy, gets here).
    // The error is dropped on purpose: it is not ours, and may carry anything. Nothing was changed.
    return problem(target, method, 'install-failed', 'the wrapper could not be installed');
  }
  return { ok: true };
}

type Inspection =
  | { readonly ok: false; readonly problem: WrapProblem }
  | {
      readonly ok: true;
      readonly owner: object;
      readonly original: ErasedMethod;
      readonly propagateExceptions: boolean;
    };

/** Everything both public functions need to know; reads descriptors, never runs a getter. */
function inspect(instance: unknown, target: unknown, method: unknown): Inspection {
  const fail = (code: WrapProblemCode, message: string): Inspection =>
    problem(target, method, code, message);

  if (typeof instance !== 'object' || instance === null) {
    return fail('invalid-instance', 'the provider instance must be an object');
  }
  const prototype = typeof target === 'function' ? prototypeOf(target) : undefined;
  if (!prototype) return fail('invalid-target', 'target must be a class');
  if (typeof method !== 'string' || method === '') {
    return fail('invalid-method-name', 'method must be a non-empty string');
  }

  const declared = Object.getOwnPropertyDescriptor(prototype, method);
  if (!declared) return fail('method-not-found', 'the target class does not declare this method');
  if (declared.get || declared.set) {
    return fail('method-is-accessor', 'a getter or setter cannot be wrapped');
  }
  const original: unknown = declared.value;
  if (!isErasedMethod(original)) return fail('method-not-function', 'it is not a function');

  // Through the descriptor: an accessor has no `value`, so it is rejected without being run.
  const customizable: unknown = Reflect.getOwnMetadata(CUSTOMIZABLE_KEY, original);
  const propagateExceptions: unknown =
    typeof customizable === 'object' && customizable !== null
      ? Object.getOwnPropertyDescriptor(customizable, 'propagateExceptions')?.value
      : undefined;
  if (typeof propagateExceptions !== 'boolean') {
    return fail('not-customizable', 'it is not marked @Customizable()');
  }

  // The method this instance would run today: the first one found walking up from the instance.
  const effective = effectiveDescriptor(instance, method);
  const current: unknown = effective?.value;
  if (typeof current === 'function' && Reflect.hasOwnMetadata(WRAPPED_KEY, current)) {
    return fail('already-wrapped', "this instance's method has already been wrapped");
  }
  // Any own property counts as a replacement, even one holding the original function: it may not
  // be redefinable, and the wrapper only ever installs where there is nothing of the instance's own.
  if (current !== original || Object.hasOwn(instance, method)) {
    return fail(
      'method-replaced',
      'the method this instance runs is not the one the target declares (an override, an own property, or another class)',
    );
  }
  if (!Object.isExtensible(instance)) {
    return fail('not-extensible', 'the instance is frozen, sealed or non-extensible');
  }
  return { ok: true, owner: instance, original, propagateExceptions };
}

/** A failed result; the message starts with `Target.method` and holds no values. */
function problem(
  target: unknown,
  method: unknown,
  code: WrapProblemCode,
  message: string,
): { readonly ok: false; readonly problem: WrapProblem } {
  const name = (typeof target === 'function' ? nameOf(target) : undefined) ?? '?';
  const label = `${name}.${typeof method === 'string' ? method.slice(0, 40) : '?'}`;
  return { ok: false, problem: { code, message: `${label}: ${message}` } };
}

/** The first own descriptor of `name` on `start` or, failing that, its prototype chain. */
function effectiveDescriptor(start: object, name: string): PropertyDescriptor | undefined {
  let holder: object | null = start;
  while (holder !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(holder, name);
    if (descriptor) return descriptor;
    const next: unknown = Object.getPrototypeOf(holder);
    holder = typeof next === 'object' ? next : null;
  }
  return undefined;
}

function isErasedMethod(value: unknown): value is ErasedMethod {
  return typeof value === 'function';
}
