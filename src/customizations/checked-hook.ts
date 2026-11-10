/**
 * The boundary between type-erased hook METADATA and the typed `HookRegistry` (E1-3, B2.1).
 *
 * `@ClientHook` metadata is read back at runtime as plain values (`unknown`): the compiler's link
 * between "this handler" and "that method's argument and result types" does not survive. So the
 * registry has a second entry point, `registerChecked`, that accepts only a `CheckedHookRegistration`,
 * and the only code that can make one is `checkClientHook` below. Three layers, three different
 * guarantees (none replaces another):
 *
 *   1. COMPILE TIME (`@ClientHook`): the handler's parameter and return type fit the target method
 *      and phase. Gone at runtime. Does not protect against `as`/`any`/plain JavaScript.
 *   2. RUNTIME SHAPE AND EXISTENCE (this file): the metadata entry is well formed and agrees with
 *      the handler's own metadata; the client and phase are known; the target is a class that
 *      itself declares a method of that name (a method, not an accessor) which carries
 *      `@Customizable()`; the handler is callable. It says NOTHING about parameter or return TYPES,
 *      which no runtime check can see.
 *   3. RUNTIME REPLACEMENT SHAPE (`runWithHooks`): for each call, what a handler returned is
 *      `undefined`, `{ args: array }` or `{ result }`. It cannot tell whether the elements or the
 *      result have the right type.
 *
 * So a `CheckedHookRegistration` means "shape-checked", not "type-checked".
 *
 * Pure: no NestJS, no logging, no hook and no application method is ever called, and the target,
 * its prototype and the names used in messages are inspected through property descriptors, so
 * their getters do not run. Whoever aggregates the problems decides how to report them.
 */
import 'reflect-metadata';
import { KNOWN_CLIENTS, type ClientCode } from '../config/env.schema.js';
import { CLIENT_HOOK_KEY } from './client-hook.decorator.js';
import { CUSTOMIZABLE_KEY } from './customizable.decorator.js';
import { HOOK_PHASES, type HookPhase, type HookTarget } from './hook.types.js';

/** A handler with its types erased. Registry storage and `registerChecked` work with this. */
export type ErasedHandler = (...args: never[]) => unknown;

/**
 * Compile-time brand: a plain object literal is not a `CheckedHookRegistration`, because the key
 * cannot be named outside this file. This is a TYPE-LEVEL restriction only: `as` casts get past it.
 * The real protection is `isCheckedHookRegistration` below, which the registry calls at runtime.
 */
const checkedBrand: unique symbol = Symbol('CheckedHookRegistration');

/**
 * One hook that passed `checkClientHook`. Frozen, and made of values captured during the check
 * (strings and references, not a view of the caller's metadata object), so changing that object
 * afterwards changes nothing here.
 */
export interface CheckedHookRegistration {
  readonly [checkedBrand]: true;
  readonly client: ClientCode;
  readonly target: HookTarget;
  readonly method: string;
  readonly phase: HookPhase;
  /** The checked method, already bound to the provider instance (the registry's contract). */
  readonly handler: ErasedHandler;
}

/** Everything `checkClientHook` made. A forged object (or a copy of one) is not in here. */
const issued = new WeakSet<object>();

/**
 * Runtime proof that `value` was produced by `checkClientHook` in this process. Unlike the type
 * brand it survives casts and plain JavaScript callers. It proves only that the check ran and
 * passed, not that the handler's types are right.
 */
export function isCheckedHookRegistration(value: unknown): value is CheckedHookRegistration {
  return typeof value === 'object' && value !== null && issued.has(value);
}

export type HookProblemCode =
  | 'invalid-metadata'
  | 'unknown-client'
  | 'client-mismatch'
  | 'unknown-phase'
  | 'invalid-target'
  | 'invalid-method-name'
  | 'method-not-found'
  | 'method-is-accessor'
  | 'method-not-function'
  | 'not-customizable'
  | 'invalid-handler'
  | 'invalid-instance'
  | 'metadata-mismatch';

/** One reason a hook was rejected. `message` always starts with the hook it is about. */
export interface HookProblem {
  readonly code: HookProblemCode;
  readonly message: string;
}

export type HookCheck =
  | { readonly ok: true; readonly registration: CheckedHookRegistration }
  | { readonly ok: false; readonly problems: readonly HookProblem[] };

/**
 * Checks ONE `@ClientHook` entry and, if it is sound, binds the handler to its provider.
 *
 * - `entry`: one element of the `ClientHookMetadata[]` found on `handler` (untrusted: any value).
 * - `handler`: the method FUNCTION that carries the `@ClientHook` metadata (not a bound copy).
 * - `instance`: the provider the method belongs to; `handler` is bound to it here, so the
 *   registered function is guaranteed to be the checked one.
 * - `expectedClient`: when given, the entry must belong to this client (the active one). Leave it
 *   out to validate any known client's hooks statically, e.g. those of inactive clients.
 *
 * All problems found are returned together, so a startup activator can report them in one go.
 * Target matching is exact: the target class must DECLARE the method itself. A subclass that only
 * inherits it is rejected; hook the declaring class. That mirrors the registry (a subclass is a
 * different key) and keeps this free of prototype-chain walking.
 *
 * Never throws for bad input and never calls the handler or the target's methods. Getters:
 * - the four fields of `entry` are read with ordinary property reads, once each, inside a guarded
 *   operation (a throwing getter makes the metadata unreadable: `invalid-metadata`); the same goes
 *   for the elements of the handler's own metadata list (`metadata-mismatch`);
 * - the target, its prototype and every name put into a message are read through descriptors, so
 *   their accessors are NOT run;
 * - the one unavoidable exception is the native `bind` of the handler, which reads its `name` and
 *   `length`; if that throws the handler is rejected (`invalid-handler`).
 * Not covered: a Proxy used as target, prototype or handler whose traps throw.
 */
export function checkClientHook(
  entry: unknown,
  handler: unknown,
  instance: unknown,
  expectedClient?: ClientCode,
): HookCheck {
  const read = readEntry(entry);
  const label = `${handlerName(handler)} -> ${read ? hookTarget(read) : '?'}`;
  const problems: HookProblem[] = [];
  const problem = (code: HookProblemCode, message: string): void => {
    problems.push({ code, message: `${label}: ${message}` });
  };

  // `.find` returns the typed constant itself, so no cast is needed to get a `ClientCode`.
  const client = KNOWN_CLIENTS.find((known) => known === read?.client);
  const phase = HOOK_PHASES.find((known) => known === read?.phase);
  const target = read && isHookTarget(read.target) ? read.target : undefined;
  const method = typeof read?.method === 'string' && read.method !== '' ? read.method : undefined;

  if (!read) {
    problem(
      'invalid-metadata',
      'metadata must be an object with readable client, target, method and phase',
    );
  } else {
    if (!client) {
      problem('unknown-client', `unknown client; known: ${KNOWN_CLIENTS.join(', ')}`);
    } else if (expectedClient !== undefined && client !== expectedClient) {
      problem(
        'client-mismatch',
        `belongs to client "${client}", but the active client is "${expectedClient}"`,
      );
    }
    if (!phase) {
      problem('unknown-phase', `unknown phase; known: ${HOOK_PHASES.join(', ')}`);
    }
    if (!target) {
      problem('invalid-target', 'target must be a class (a function with a prototype object)');
    }
    if (method === undefined) {
      problem('invalid-method-name', 'method must be a non-empty string');
    }
    if (target && method !== undefined) {
      checkTargetMethod(target, method, problem);
    }
  }

  if (!isErasedHandler(handler)) {
    problem('invalid-handler', 'the handler must be a function');
  } else if (read && !carriesEntry(handler, read)) {
    problem(
      'metadata-mismatch',
      "the handler's own @ClientHook metadata has no entry equal to this one",
    );
  }
  if (typeof instance !== 'object' || instance === null) {
    problem('invalid-instance', 'the provider instance must be an object');
  }

  if (problems.length > 0 || !client || !phase || !target || method === undefined) {
    return { ok: false, problems };
  }
  if (!isErasedHandler(handler) || typeof instance !== 'object' || instance === null) {
    return { ok: false, problems };
  }

  // Native binding keeps the function's own `name`, `length` and `this` semantics. It READS the
  // handler's `name` and `length`, which an untrusted function may have turned into throwing
  // accessors, so a failure here is a problem with the handler, not an exception.
  // The one assertion on the success path: `Function.prototype.bind` (taken from the prototype, so
  // a function with its own `bind` property cannot interfere) returns a function when it returns at
  // all, and it is typed `any`. The result is only a bound copy of `handler`, which was just checked.
  let bound: ErasedHandler;
  try {
    bound = Function.prototype.bind.call(handler, instance) as ErasedHandler;
  } catch {
    problem('invalid-handler', 'the handler cannot be bound (reading its name or length failed)');
    return { ok: false, problems };
  }
  const registration: CheckedHookRegistration = Object.freeze({
    [checkedBrand]: true as const,
    client,
    target,
    method,
    phase,
    handler: bound,
  });
  issued.add(registration);
  return { ok: true, registration };
}

/** The four fields of an entry, each read exactly once. `undefined` if it is not readable. */
interface RawEntry {
  readonly client: unknown;
  readonly target: unknown;
  readonly method: unknown;
  readonly phase: unknown;
}

function readEntry(value: unknown): RawEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    // A getter that throws is as unusable as a missing field; one read per field, kept in locals.
    const { client, target, method, phase } = value as Record<string, unknown>;
    return { client, target, method, phase };
  } catch {
    return undefined;
  }
}

/**
 * Does the handler's own metadata contain an entry with the same four values? `getOwnMetadata`:
 * `@ClientHook` stores on the method function itself, so nothing is inherited or looked up by name.
 *
 * The list is untrusted too (forged metadata can be any array, even a proxy), so it is walked with
 * the built-in `Array.prototype.some` instead of its own `.some` or iterator, which it could have
 * replaced. Reading an element or the length can still run a getter or proxy trap that throws; that
 * counts as "no matching entry", like any other unreadable metadata.
 */
function carriesEntry(handler: ErasedHandler, wanted: RawEntry): boolean {
  try {
    const own: unknown = Reflect.getOwnMetadata(CLIENT_HOOK_KEY, handler);
    if (!Array.isArray(own)) return false;
    return Array.prototype.some.call(own, (candidate: unknown) => {
      const found = readEntry(candidate);
      return (
        found !== undefined &&
        found.client === wanted.client &&
        found.target === wanted.target &&
        found.method === wanted.method &&
        found.phase === wanted.phase
      );
    });
  } catch {
    return false;
  }
}

/**
 * The target's own member, looked at through its descriptor (a getter would be CALLED by a plain
 * property read, a descriptor is only looked at).
 */
function checkTargetMethod(
  target: HookTarget,
  method: string,
  problem: (code: HookProblemCode, message: string) => void,
): void {
  const prototype = prototypeOf(target);
  const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, method) : undefined;
  if (!descriptor) {
    problem(
      'method-not-found',
      `${nameOf(target) ?? '(anonymous class)'} does not declare the hooked method itself; an inherited method is not enough, hook the class that declares it`,
    );
    return;
  }
  if (descriptor.get || descriptor.set) {
    problem('method-is-accessor', `"${method}" is a getter or setter, not a method`);
    return;
  }
  const value: unknown = descriptor.value;
  if (typeof value !== 'function') {
    problem('method-not-function', `"${method}" is not a function`);
    return;
  }
  const customizable: unknown = Reflect.getOwnMetadata(CUSTOMIZABLE_KEY, value);
  if (typeof customizable !== 'object' || customizable === null) {
    problem('not-customizable', `"${method}" is not marked @Customizable()`);
  }
}

/** Narrows `unknown` to a class. A runtime check cannot tell a class from an old-style function. */
function isHookTarget(value: unknown): value is HookTarget {
  return typeof value === 'function' && prototypeOf(value) !== undefined;
}

/** The `prototype` object of a function, read through its descriptor (no getter is run). */
export function prototypeOf(fn: object): object | undefined {
  const prototype: unknown = Object.getOwnPropertyDescriptor(fn, 'prototype')?.value;
  return typeof prototype === 'object' && prototype !== null ? prototype : undefined;
}

/**
 * A function's `name` for messages, read through its descriptor so that a `name` accessor (a class
 * may declare a static one, a forged function anything) is never run. `undefined`: use a fallback.
 */
export function nameOf(fn: object): string | undefined {
  const name: unknown = Object.getOwnPropertyDescriptor(fn, 'name')?.value;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

export function isErasedHandler(value: unknown): value is ErasedHandler {
  return typeof value === 'function';
}

function handlerName(handler: unknown): string {
  return (typeof handler === 'function' ? nameOf(handler) : undefined) ?? '(unnamed handler)';
}

/**
 * `Target.method (client, phase)` for the start of every message of one entry. The entry is
 * UNTRUSTED, and a diagnostic must not repeat what it says, so only these may appear: the name of a
 * class (read from the class itself), the name of a method that really is a member of that class's
 * prototype (read from the class, not from the entry), and a client or phase that is one of the
 * known constants. Anything else is `?`, and a value of the wrong kind is described by its kind.
 */
function hookTarget(read: RawEntry): string {
  const target = isHookTarget(read.target) ? read.target : undefined;
  const targetName =
    typeof read.target === 'function'
      ? (nameOf(read.target) ?? '(anonymous class)')
      : '(not a class)';
  const prototype = target ? prototypeOf(target) : undefined;
  const methodName =
    typeof read.method === 'string' &&
    prototype !== undefined &&
    Object.getOwnPropertyDescriptor(prototype, read.method) !== undefined
      ? read.method
      : '?';
  const client = KNOWN_CLIENTS.find((known) => known === read.client) ?? '?';
  const phase = HOOK_PHASES.find((known) => known === read.phase) ?? '?';
  return `${targetName}.${methodName} (${client}, ${phase})`;
}
