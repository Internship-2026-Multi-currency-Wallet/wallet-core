import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { types } from 'node:util';
import { AppConfig } from '../config/app-config.js';
import type { ClientCode } from '../config/env.schema.js';
import { nameOf } from './checked-hook.js';
import {
  CLIENT_DISABLED_KEY,
  CLIENT_FEATURE_KEY,
  clientAvailabilityOf,
} from './client-availability.decorator.js';

/**
 * Every restriction that applies to one endpoint. Each entry is the list of ONE annotated target
 * (a class up the inheritance chain, or one definition of the method up the chain).
 */
export interface AvailabilityRules {
  /** Allow-lists (`@ClientFeature`): the client has to be in EVERY one of them. */
  readonly feature: readonly (readonly ClientCode[])[];
  /** Deny-lists (`@ClientDisabled`): the client must be in NONE of them. */
  readonly disabled: readonly (readonly ClientCode[])[];
}

export interface AvailabilityProblem {
  /**
   * `malformed-metadata`: restriction metadata that is present but invalid (forged or damaged).
   * `unresolved-handler`: the handler could not be matched to a method name on the class chain,
   * and the chain has method-level restrictions that therefore cannot be looked up.
   * `unresolved-class-chain`: the chain of ancestors could not be walked to its end (a prototype
   * could not be read, the chain loops, or it ends in something that is not a class), so an
   * ancestor's restriction may be missing.
   */
  readonly code: 'malformed-metadata' | 'unresolved-handler' | 'unresolved-class-chain';
  /** Source names only (`Class` or `Class.method`), never a value from the metadata. */
  readonly where: string;
}

export interface CollectedAvailability {
  readonly rules: AvailabilityRules;
  /** Not empty: the rules are incomplete and the endpoint must be treated as unavailable. */
  readonly problems: readonly AvailabilityProblem[];
}

/**
 * Collects ALL restrictions of one endpoint: no inherited-metadata lookup is used anywhere, because
 * one that follows the prototype chain returns the nearest annotation and hides the others.
 *
 * - CLASSES: the resolver's class and every ancestor, each through its own metadata.
 * - METHODS: the handler Nest passes is the function of the class that was instantiated. EVERY
 *   property NAME under which a class of the chain defines that function is collected (one function
 *   may sit under several names, and Nest may have reached it under any of them), and each name is
 *   then looked up in every class up the chain. So a method that overrides an annotated one (and
 *   carries no annotation itself) still has the restrictions of what it overrides, whichever alias
 *   is used and in whatever order the names were declared.
 *
 * Read-only: nothing is called, no getter is run. A malformed list does not throw: it is reported
 * in `problems`, so an enforcer can fail closed now and a startup check can list them later.
 */
export function collectAvailability(handlerClass: object, handler: object): CollectedAvailability {
  const feature: (readonly ClientCode[])[] = [];
  const disabled: (readonly ClientCode[])[] = [];
  const problems: AvailabilityProblem[] = [];
  const seen = new Set<object>();

  const take = (target: object, where: string): void => {
    if (seen.has(target)) return;
    seen.add(target);
    try {
      const own = clientAvailabilityOf(target);
      if (own.feature) feature.push(own.feature);
      if (own.disabled) disabled.push(own.disabled);
    } catch {
      problems.push({ code: 'malformed-metadata', where });
    }
  };

  const { chain, complete } = classChain(handlerClass);
  if (!complete) problems.push({ code: 'unresolved-class-chain', where: classLabel(handlerClass) });
  for (const cls of chain) take(cls, classLabel(cls));

  const keys = methodKeysOf(chain, handler);
  if (keys.length === 0) {
    // Cannot say which method this is. Its own annotation, if it has one, still counts.
    take(handler, 'the handler');
    if (chain.some(hasMethodRestriction)) {
      problems.push({ code: 'unresolved-handler', where: classLabel(handlerClass) });
    }
  } else {
    for (const key of keys) {
      for (const cls of chain) {
        const definition = ownMethod(cls, key);
        if (definition !== undefined) take(definition, `${classLabel(cls)}.${String(key)}`);
      }
    }
  }
  return { rules: { feature, disabled }, problems };
}

/** Does `client` pass every restriction? Narrow-only: allow-lists AND-ed, deny-lists AND-ed. */
export function isAvailableTo(client: ClientCode, rules: AvailabilityRules): boolean {
  return (
    rules.feature.every((list) => list.includes(client)) &&
    !rules.disabled.some((list) => list.includes(client))
  );
}

/**
 * The class and its ancestors, most derived first, walked to the natural end of the chain
 * (`Function.prototype`, or `null`): there is no depth limit, because a limit would silently drop
 * the restrictions of the ancestors beyond it. `complete: false` means the walk could not reach
 * that end (a prototype that cannot be read, a loop, or something that is not a class at the end),
 * and the caller must not treat the chain as the whole story.
 */
export function classChain(cls: object): { chain: object[]; complete: boolean } {
  const chain: object[] = [];
  const visited = new Set<object>();
  try {
    let current: unknown = cls;
    while (!isEndOfChain(current)) {
      if (typeof current !== 'function' || visited.has(current)) return { chain, complete: false };
      visited.add(current);
      chain.push(current);
      current = Object.getPrototypeOf(current);
    }
  } catch {
    return { chain, complete: false };
  }
  return { chain, complete: true };
}

/**
 * A class from another realm (`node:vm`, a test runner's sandbox) ends in that realm's
 * `Function.prototype`, so comparing with ours alone would report a complete chain as unreadable and
 * hide the endpoint from every client. Anything else that merely resembles the end must stay
 * unrecognised, so the chain is reported incomplete (fail closed) instead of silently dropping what
 * the impostor carries. A restriction on the terminal itself is never discarded for the same reason.
 */
function isEndOfChain(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'function') return false;
  if (Reflect.hasOwnMetadata(CLIENT_FEATURE_KEY, value)) return false;
  if (Reflect.hasOwnMetadata(CLIENT_DISABLED_KEY, value)) return false;
  return value === Function.prototype || isForeignFunctionPrototype(value);
}

/**
 * Recognises a realm's `Function.prototype` by invariants the engine fixes for it and that ordinary
 * code does not produce by accident: it is a function without an own `prototype`, its `constructor`
 * (that realm's `Function`) inherits from it and points back to it through a non-writable,
 * non-configurable `prototype`, and it inherits from a root object. Read through descriptors and
 * with proxies refused, so no getter or trap runs. A deliberately forged imitation is not in scope:
 * this guards against mistakes, not against code that already runs inside the process.
 */
function isForeignFunctionPrototype(value: object): boolean {
  if (types.isProxy(value) || Object.hasOwn(value, 'prototype')) return false;
  const constructor: unknown = Object.getOwnPropertyDescriptor(value, 'constructor')?.value;
  if (typeof constructor !== 'function' || types.isProxy(constructor)) return false;
  const backlink = Object.getOwnPropertyDescriptor(constructor, 'prototype');
  if (backlink?.value !== value || backlink.writable !== false || backlink.configurable !== false) {
    return false;
  }
  if (Object.getPrototypeOf(constructor) !== value) return false;
  const parent: unknown = Object.getPrototypeOf(value);
  return (
    typeof parent === 'object' &&
    parent !== null &&
    !types.isProxy(parent) &&
    Object.getPrototypeOf(parent) === null
  );
}

/** The method defined by `cls` ITSELF under `key`, looked at through its descriptor. */
function ownMethod(cls: object, key: string | symbol): object | undefined {
  const prototype: unknown = Object.getOwnPropertyDescriptor(cls, 'prototype')?.value;
  if (typeof prototype !== 'object' || prototype === null) return undefined;
  const value: unknown = Object.getOwnPropertyDescriptor(prototype, key)?.value;
  return typeof value === 'function' ? value : undefined;
}

/** Every name under which a class of the chain defines `handler` (usually one), without repeats. */
function methodKeysOf(chain: readonly object[], handler: object): (string | symbol)[] {
  const keys = new Set<string | symbol>();
  for (const cls of chain) {
    const prototype: unknown = Object.getOwnPropertyDescriptor(cls, 'prototype')?.value;
    if (typeof prototype !== 'object' || prototype === null) continue;
    for (const key of Reflect.ownKeys(prototype)) {
      if (key === 'constructor') continue;
      if (Object.getOwnPropertyDescriptor(prototype, key)?.value === handler) keys.add(key);
    }
  }
  return [...keys];
}

/** Does any method defined by `cls` carry restriction metadata (valid or not)? Existence only. */
function hasMethodRestriction(cls: object): boolean {
  const prototype: unknown = Object.getOwnPropertyDescriptor(cls, 'prototype')?.value;
  if (typeof prototype !== 'object' || prototype === null) return false;
  return Reflect.ownKeys(prototype).some((key) => {
    // `constructor` is the class itself, whose own (class-level) metadata is not a method's.
    if (key === 'constructor') return false;
    const value: unknown = Object.getOwnPropertyDescriptor(prototype, key)?.value;
    return (
      typeof value === 'function' &&
      (Reflect.hasOwnMetadata(CLIENT_FEATURE_KEY, value) ||
        Reflect.hasOwnMetadata(CLIENT_DISABLED_KEY, value))
    );
  });
}

function classLabel(cls: object): string {
  return nameOf(cls) ?? '(anonymous class)';
}

/**
 * Hides the endpoints that the configured client must not have (`@ClientFeature`,
 * `@ClientDisabled`): the call fails with `NOT_FOUND`, as if the endpoint did not exist.
 *
 * It decides only availability. It authenticates nobody and checks no permission, so it works with
 * the auth and permission guards and does not replace them. Whether it runs before or after them
 * is decided where it is registered, not here.
 *
 * Fails closed: restriction metadata that is malformed, or a handler that cannot be matched to a
 * method when the class chain has method-level restrictions, makes the endpoint unavailable to
 * EVERY client. An endpoint without any restriction is always available.
 */
@Injectable()
export class ClientAvailabilityGuard implements CanActivate {
  constructor(@Inject(AppConfig) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const { rules, problems } = collectAvailability(context.getClass(), context.getHandler());
    if (problems.length === 0 && isAvailableTo(this.config.client, rules)) return true;

    // The same exception for GraphQL and HTTP, so that one shared error mapping covers every 404.
    // Its default message names no client, feature or reason.
    throw new NotFoundException();
  }
}
