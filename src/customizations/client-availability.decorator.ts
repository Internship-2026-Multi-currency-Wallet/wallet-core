import { Extensions } from '@nestjs/graphql';
import 'reflect-metadata';
import { KNOWN_CLIENTS, type ClientCode } from '../config/env.schema.js';

export const CLIENT_FEATURE_KEY = 'customizations:clientFeature';
export const CLIENT_DISABLED_KEY = 'customizations:clientDisabled';

/** At least one client, checked by the compiler: `@ClientFeature()` does not compile. */
type OneOrMoreClients = [ClientCode, ...ClientCode[]];

/**
 * Usable on a class, on an instance method and on an instance property. Anything else (an accessor,
 * a static member, a parameter) is rejected at runtime, see `targetOf`.
 */
export type ClientAvailabilityDecorator = ClassDecorator & MethodDecorator & PropertyDecorator;

/**
 * Makes a GraphQL endpoint, or a single field, available ONLY to the listed clients (an
 * allow-list). For any other client it is to answer `NOT_FOUND`, as if it did not exist:
 *
 *   @ClientFeature('wisla')
 *   @Query(() => Statement)
 *   wislaStatement() { ... }                           // a root endpoint: enforced by the guard
 *
 *   @ClientFeature('wisla')
 *   @Field(() => String, { nullable: true })
 *   wislaNote?: string;                                // a plain field: enforced by the schema
 *
 *   @ClientFeature('wisla')
 *   @ResolveField(() => String, { nullable: true })
 *   wislaBalance(@Parent() account: Account) { ... }   // a field resolver: enforced by the schema
 *
 * This only ATTACHES METADATA. Nothing is enforced by this file; two other pieces read it:
 * - `ClientAvailabilityGuard` for the root endpoints (a class, or a Query/Mutation/Subscription
 *   method). Nest does NOT run guards on `@ResolveField` handlers or on plain fields;
 * - `restrictClientFields` (a `transformSchema` function) for fields. It reads the `@Extensions`
 *   entry that this decorator writes next to the metadata, on a property and on a method.
 *
 * Where the metadata goes (always the target's OWN metadata, never an inheriting one):
 * - a class: on the class. A method: on the method function. A property: on the prototype, under
 *   the property's key (`Reflect.getOwnMetadata(key, prototype, 'name')`);
 * - a property and a method also get the `@Extensions` entry, keyed by the same `CLIENT_*_KEY`.
 *   For a root method it is written too and not used: the guard enforces root endpoints.
 *
 * Rules (the metadata is stored to make them possible):
 * - restrictions only NARROW: a class-level and a method-level restriction both have to allow the
 *   client (an intersection), so a method can never widen what its class allows. The same goes
 *   for classes up an inheritance chain;
 * - therefore the metadata is stored as the target's OWN metadata and must be read with
 *   `getOwnMetadata` (see `clientAvailabilityOf`). `Reflect.getMetadata` / `Reflector.get` on a
 *   class returns the nearest class that has any, so a subclass that adds its own annotation would
 *   HIDE its base class's one, and a restriction would be lost;
 * - an overriding method is a new function and carries no metadata of the method it overrides. The
 *   guard has to look the method up by NAME along the class chain; this file cannot know about the
 *   subclass at decoration time.
 *
 * Checked at decoration time (a mistake stops the process at import, never at the first request):
 * - the compiler requires at least one client and only `ClientCode` values;
 * - at runtime the clients must be known (also for plain JavaScript or `as` casts), and a repeated
 *   client is stored once;
 * - the target must be a class, an instance method or an instance property. A getter/setter, a
 *   static member or a parameter throws a `TypeError`;
 * - the same decorator may be used ONCE per target (`@ClientFeature('a') @ClientFeature('b')`
 *   would silently keep only one of them). List all clients in one call;
 * - `@ClientFeature` and `@ClientDisabled` may NOT both be on one target: it is either an
 *   allow-list or a deny-list. (Different targets may combine them: a `@ClientFeature` class with a
 *   `@ClientDisabled` method is fine, and the two lists are intersected.)
 *
 * Not checkable here, so whoever enforces the metadata verifies it when the application starts
 * (`ClientAvailabilityValidator`, `restrictClientFields`): that a field is nullable, that a method
 * is really an endpoint, that a class is a resolver and not an HTTP controller or a service, and
 * that a class-level restriction does not sit on a resolver that has `@ResolveField` methods
 * (a field resolver would silently ignore it).
 */
export function ClientFeature(...clients: OneOrMoreClients): ClientAvailabilityDecorator {
  return decorate('ClientFeature', CLIENT_FEATURE_KEY, clients);
}

/**
 * Hides a GraphQL endpoint, or a single field, from the listed clients (a deny-list); every other
 * client keeps it. Meant for core endpoints and fields that a client must not have:
 *
 *   @ClientDisabled('wisla')
 *   @Mutation(() => Boolean)
 *   cancelTransfer() { ... }
 *
 * Same rules, same limits and same metadata handling as `ClientFeature`; see there.
 */
export function ClientDisabled(...clients: OneOrMoreClients): ClientAvailabilityDecorator {
  return decorate('ClientDisabled', CLIENT_DISABLED_KEY, clients);
}

/** What one target says about client availability. `undefined`: it says nothing. */
export interface ClientAvailability {
  readonly feature: readonly ClientCode[] | undefined;
  readonly disabled: readonly ClientCode[] | undefined;
}

export type AvailabilityDecoratorName = 'ClientFeature' | 'ClientDisabled';

/**
 * The availability metadata written directly on `target` (a class, or a method function), and not
 * what it inherits. With `propertyKey`, that of a property: `target` is then the class PROTOTYPE.
 * See `ClientFeature` for why a guard must not use an inheriting lookup.
 *
 * Absent metadata is `undefined`. Metadata that is PRESENT but is not what the decorators write (a
 * string, an empty list, an unknown or wrongly cased client, a hole, ...) throws a `TypeError` with
 * a fixed message instead of being read as "no restriction" or an empty one: a deny-list that is
 * quietly dropped would let a client through, so malformed metadata has to stop whoever enforces
 * it. Only the decorators write this metadata, so this happens only to forged or damaged metadata.
 */
export function clientAvailabilityOf(
  target: object,
  propertyKey?: string | symbol,
): ClientAvailability {
  return {
    feature: ownClients('ClientFeature', CLIENT_FEATURE_KEY, target, propertyKey),
    disabled: ownClients('ClientDisabled', CLIENT_DISABLED_KEY, target, propertyKey),
  };
}

function hasOwn(key: string, target: object, propertyKey: string | symbol | undefined): boolean {
  return propertyKey === undefined
    ? Reflect.hasOwnMetadata(key, target)
    : Reflect.hasOwnMetadata(key, target, propertyKey);
}

function ownClients(
  name: AvailabilityDecoratorName,
  key: string,
  target: object,
  propertyKey: string | symbol | undefined,
): readonly ClientCode[] | undefined {
  if (!hasOwn(key, target, propertyKey)) return undefined;
  const stored: unknown =
    propertyKey === undefined
      ? Reflect.getOwnMetadata(key, target)
      : Reflect.getOwnMetadata(key, target, propertyKey);
  return parseClientList(name, stored);
}

/**
 * Reads a stored list of clients (metadata, or a GraphQL field extension) the way the decorators
 * wrote it, or throws a `TypeError` with a FIXED message: see `clientAvailabilityOf` for why
 * nothing is repaired or skipped, and why the message never repeats a value.
 */
export function parseClientList(
  name: AvailabilityDecoratorName,
  stored: unknown,
): readonly ClientCode[] {
  const malformed = (): TypeError =>
    new TypeError(`@${name} metadata is malformed: expected a non-empty list of known clients`);
  const clients: ClientCode[] = [];
  try {
    // Everything that touches the stored value is in here: `Array.isArray` (a revoked proxy
    // throws), `length` and the elements. Plain reads: the list is ours (frozen by the
    // decorators), and anything else that throws while being read (a getter, a proxy) is just as
    // malformed. The original error is dropped, not chained: it may hold anything.
    if (!Array.isArray(stored) || stored.length === 0) throw malformed();
    for (let index = 0; index < stored.length; index += 1) {
      const entry: unknown = stored[index];
      const client = KNOWN_CLIENTS.find((candidate) => candidate === entry);
      if (client === undefined) throw malformed();
      if (!clients.includes(client)) clients.push(client);
    }
  } catch {
    throw malformed();
  }
  return Object.freeze(clients);
}

function decorate(
  name: AvailabilityDecoratorName,
  key: string,
  clients: readonly unknown[],
): ClientAvailabilityDecorator {
  const stored = validClients(name, clients);
  const otherName: AvailabilityDecoratorName =
    name === 'ClientFeature' ? 'ClientDisabled' : 'ClientFeature';
  const otherKey = key === CLIENT_FEATURE_KEY ? CLIENT_DISABLED_KEY : CLIENT_FEATURE_KEY;
  return (target: object, propertyKey?: string | symbol, descriptor?: unknown): void => {
    // Everything is checked before anything is written.
    const { holder, member } = targetOf(name, target, propertyKey, descriptor);
    if (hasOwn(key, holder, member)) {
      throw new TypeError(
        `@${name}() is already used on ${describe(target, propertyKey)}; list all clients in one call`,
      );
    }
    if (hasOwn(otherKey, holder, member)) {
      throw new TypeError(
        `@${name}() and @${otherName}() cannot both be used on ${describe(target, propertyKey)}; a target is either an allow-list or a deny-list`,
      );
    }
    if (member === undefined) Reflect.defineMetadata(key, stored, holder);
    else Reflect.defineMetadata(key, stored, holder, member);
    // A method or a property is, or may be, a GraphQL field: Nest copies the entry into the
    // field's `extensions` when the schema is built, whatever the order of the decorators.
    if (propertyKey !== undefined) Extensions({ [key]: stored })(target, propertyKey);
  };
}

interface DecoratedTarget {
  /** What the metadata is stored on: a class, a method's function, or a class prototype. */
  readonly holder: object;
  /** The property key, only for a property (stored on the prototype under that key). */
  readonly member: string | symbol | undefined;
}

function targetOf(
  name: AvailabilityDecoratorName,
  target: unknown,
  propertyKey: string | symbol | undefined,
  descriptor: unknown,
): DecoratedTarget {
  if (propertyKey === undefined) {
    // A class decorator is called with the class only. A constructor PARAMETER decorator gets the
    // same class and `undefined` as the key, plus the parameter's index as a third argument.
    if (typeof target === 'function' && descriptor === undefined) {
      return { holder: target, member: undefined };
    }
  } else if (typeof target === 'object' && target !== null) {
    // `target` is the prototype here (for a static member it is the class, a function, and falls
    // through to the error). A property has no descriptor. A method has a descriptor that holds a
    // function. A getter/setter has a descriptor without `value`, a method parameter gets a number.
    if (descriptor === undefined) return { holder: target, member: propertyKey };
    const method: unknown =
      typeof descriptor === 'object' && descriptor !== null
        ? (descriptor as { value?: unknown }).value
        : undefined;
    if (typeof method === 'function') {
      return { holder: method, member: undefined };
    }
  }
  throw new TypeError(
    `@${name}() can only decorate a class, an instance method or an instance property, not ${describe(target, propertyKey)} (an accessor, static member or parameter)`,
  );
}

/** Source names only (a class name, a member name): never a value. */
function describe(target: unknown, propertyKey: string | symbol | undefined): string {
  if (propertyKey !== undefined) return `"${String(propertyKey)}"`;
  const name: unknown =
    typeof target === 'function'
      ? Object.getOwnPropertyDescriptor(target, 'name')?.value
      : undefined;
  return typeof name === 'string' && name !== '' ? `class ${name}` : 'this class';
}

/**
 * Validates, de-duplicates and freezes the clients. The message never repeats a rejected value:
 * it may come from anywhere (plain JavaScript, a cast, configuration).
 */
function validClients(
  name: AvailabilityDecoratorName,
  clients: readonly unknown[],
): readonly ClientCode[] {
  if (clients.length === 0) {
    throw new TypeError(`@${name}() needs at least one client; known: ${KNOWN_CLIENTS.join(', ')}`);
  }
  const valid: ClientCode[] = [];
  for (const client of clients) {
    const known = KNOWN_CLIENTS.find((candidate) => candidate === client);
    if (known === undefined) {
      throw new TypeError(`@${name}() got an unknown client; known: ${KNOWN_CLIENTS.join(', ')}`);
    }
    if (!valid.includes(known)) valid.push(known);
  }
  return Object.freeze(valid);
}
