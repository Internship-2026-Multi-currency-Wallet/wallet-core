/**
 * Read-only discovery for the hook activator (E1-3, B2.3): which provider methods are
 * `@ClientHook` handlers, and which provider instances are the objects a hook targets.
 *
 * It works on a LIST of providers handed in by the caller (the activator takes it from
 * `DiscoveryService.getProviders()`, narrowed to a module where that makes sense), so it knows
 * nothing about clients, registries, wrapping or logging, and a plain test double is enough to
 * exercise it. Nothing is called: no hook, no application method, no getter; instances are only
 * looked at through property descriptors and prototype links.
 *
 * Matching is exact, like the registry and the wrapper: an instance belongs to `target` only if its
 * prototype IS `target.prototype`. A subclass instance does not.
 *
 * Providers that are not singletons (request-scoped, transient, or depending on something that
 * is) cannot be used: Nest keeps only a placeholder object for them (made from the prototype,
 * without running the constructor), so a wrapper or a bound handler on it would silently never
 * apply to the instances that serve requests. They are reported only when they matter, i.e. when
 * they hold a hook or are the target of one, so unrelated request-scoped providers cause no noise.
 */
import 'reflect-metadata';
import { CONTROLLER_WATERMARK, ENTRY_PROVIDER_WATERMARK } from '@nestjs/common/constants.js';
import { type ErasedHandler, isErasedHandler, nameOf, prototypeOf } from './checked-hook.js';
import { CLIENT_HOOK_KEY } from './client-hook.decorator.js';
import type { HookTarget } from './hook.types.js';

/** The part of Nest's `InstanceWrapper` that is needed here, so tests can use plain objects. */
export interface ProviderLike {
  readonly instance: unknown;
  readonly isTransient: boolean;
  isDependencyTreeStatic(): boolean;
}

export type ScanProblemCode =
  'unsupported-scope' | 'invalid-hook-metadata' | 'no-provider' | 'unsupported-target';

/** Why something could not be used. `message` names classes and methods, never values. */
export interface ScanProblem {
  readonly code: ScanProblemCode;
  readonly message: string;
}

export interface Scan<T> {
  readonly found: readonly T[];
  readonly problems: readonly ScanProblem[];
}

/** One method of a provider that carries `@ClientHook` metadata. */
export interface HookMethod {
  /** The provider instance the method belongs to (bind the handler to this). */
  readonly instance: object;
  /** For diagnostics only. */
  readonly name: string;
  /** The method function itself, not a bound copy: it is the one that carries the metadata. */
  readonly handler: ErasedHandler;
  /** A copy of the `@ClientHook` entries (untrusted: `checkClientHook` validates each). */
  readonly entries: readonly unknown[];
}

/**
 * The `@ClientHook` methods of the given providers' instances, in provider order and, within an
 * instance, in definition order (own members first, then up the prototype chain).
 *
 * A member counts if the instance would really run it: the first definition found walking up
 * from the instance wins, so an override that is not decorated again hides its base class's
 * decorated method (as documented for `@ClientHook`). Accessors are never read, so a getter that
 * returns a function is not a method.
 */
export function scanHookMethods(providers: Iterable<ProviderLike>): Scan<HookMethod> {
  const found: HookMethod[] = [];
  const problems: ScanProblem[] = [];
  for (const { provider, instance } of uniqueObjects(providers)) {
    const methods = hookFunctionsOf(instance);
    if (methods.length === 0) continue;
    const owner = classNameOf(instance);
    if (!isSingleton(provider)) {
      problems.push({
        code: 'unsupported-scope',
        message: `${owner}: its hook methods (${methods.map((m) => m.name).join(', ')}) cannot be used because the provider is request-scoped or transient`,
      });
      continue;
    }
    for (const { name, handler } of methods) {
      const entries = entriesOf(handler);
      if (entries) found.push({ instance, name, handler, entries });
      else {
        problems.push({
          code: 'invalid-hook-metadata',
          message: `${owner}.${name}: the @ClientHook metadata is not a list`,
        });
      }
    }
  }
  return { found, problems };
}

/**
 * The provider instances that are exactly a `target` (see the file comment): zero or more, each
 * once, however many tokens or aliases lead to it. Several are normal (a class listed in the
 * `providers` of two modules gets one instance per module). A problem is reported when:
 * - `target` is a controller or a resolver, or another entry provider (`unsupported-target`; put
 *   the customizable logic in a service). Nest reads their methods when it registers routes and
 *   resolvers, which is before an activator runs at bootstrap: an HTTP route takes `instance[method]`
 *   once at that moment, a GraphQL resolver takes the method from the prototype. A wrapper on the
 *   instance is therefore not reliably used (see the tests for what each kind does);
 * - a matching provider is not a singleton (`unsupported-scope`);
 * - nothing matches at all (`no-provider`).
 */
export function findTargetInstances(
  providers: Iterable<ProviderLike>,
  target: HookTarget,
): Scan<object> {
  const targetName = nameOf(target) ?? '(anonymous class)';
  const prototype = prototypeOf(target);
  if (!prototype) {
    return single('unsupported-target', `${targetName}: the target must be a class`);
  }
  if (
    Reflect.hasMetadata(CONTROLLER_WATERMARK, target) ||
    Reflect.hasMetadata(ENTRY_PROVIDER_WATERMARK, target)
  ) {
    return single(
      'unsupported-target',
      `${targetName}: a controller or resolver cannot be a hook target (Nest picks up their methods when it registers routes and resolvers, so hooks installed later are not reliably used); put the logic in a service`,
    );
  }

  const found: object[] = [];
  const problems: ScanProblem[] = [];
  for (const { provider, instance } of uniqueObjects(providers)) {
    if (Object.getPrototypeOf(instance) !== prototype) continue;
    if (isSingleton(provider)) found.push(instance);
    else {
      problems.push({
        code: 'unsupported-scope',
        message: `${targetName}: a provider of this class is request-scoped or transient and cannot be wrapped`,
      });
    }
  }
  if (found.length === 0 && problems.length === 0) {
    problems.push({
      code: 'no-provider',
      message: `${targetName}: no provider of exactly this class exists in the application`,
    });
  }
  return { found, problems };
}

function single(code: ScanProblemCode, message: string): Scan<object> {
  return { found: [], problems: [{ code, message }] };
}

/** Each distinct object instance once, with the first provider that holds it (aliases repeat it). */
function* uniqueObjects(
  providers: Iterable<ProviderLike>,
): Generator<{ provider: ProviderLike; instance: object }> {
  const seen = new Set<object>();
  for (const provider of providers) {
    const instance = provider.instance;
    // Primitives, `null` and functions (a Knex client, for one) hold no class instance.
    if (typeof instance !== 'object' || instance === null || seen.has(instance)) continue;
    seen.add(instance);
    yield { provider, instance };
  }
}

function isSingleton(provider: ProviderLike): boolean {
  return provider.isDependencyTreeStatic() && !provider.isTransient;
}

/** Members with `@ClientHook` metadata that the instance would really run; descriptors only. */
function hookFunctionsOf(instance: object): { name: string; handler: ErasedHandler }[] {
  const hidden = new Set<string | symbol>();
  const methods: { name: string; handler: ErasedHandler }[] = [];
  let holder: object | null = instance;
  while (holder !== null && holder !== Object.prototype) {
    for (const key of Reflect.ownKeys(holder)) {
      if (hidden.has(key)) continue;
      hidden.add(key); // the first definition wins, whatever it is
      const value: unknown = Object.getOwnPropertyDescriptor(holder, key)?.value;
      if (isErasedHandler(value) && Reflect.hasOwnMetadata(CLIENT_HOOK_KEY, value)) {
        methods.push({ name: String(key), handler: value });
      }
    }
    const next: unknown = Object.getPrototypeOf(holder);
    holder = typeof next === 'object' ? next : null;
  }
  return methods;
}

/**
 * A private copy of the metadata list as a plain new array, or `undefined` if it is not a plain,
 * fully readable list. Built by hand from property DESCRIPTORS: the list is untrusted, and
 * `slice`/spread/`Array.from` would run its index getters, its iterator, or build the result with
 * whatever constructor or `Symbol.species` it names (even the list itself). `@ClientHook` only
 * ever stores a dense array of data entries, so an accessor or a hole means forged metadata.
 */
function entriesOf(handler: ErasedHandler): readonly unknown[] | undefined {
  const own: unknown = Reflect.getOwnMetadata(CLIENT_HOOK_KEY, handler);
  if (!Array.isArray(own)) return undefined;
  try {
    const length: unknown = Object.getOwnPropertyDescriptor(own, 'length')?.value;
    if (typeof length !== 'number') return undefined;
    const copy: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(own, index);
      if (!descriptor || !('value' in descriptor)) return undefined; // a hole or an accessor
      copy.push(descriptor.value);
    }
    return copy;
  } catch {
    return undefined; // e.g. a proxy whose traps throw
  }
}

export function classNameOf(instance: object): string {
  const prototype: unknown = Object.getPrototypeOf(instance);
  const constructor: unknown =
    typeof prototype === 'object' && prototype !== null
      ? Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value
      : undefined;
  return (
    (typeof constructor === 'function' ? nameOf(constructor) : undefined) ?? '(anonymous class)'
  );
}
