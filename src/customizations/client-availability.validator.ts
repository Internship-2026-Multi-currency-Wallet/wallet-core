import { Inject, Injectable, type OnApplicationBootstrap, type Type } from '@nestjs/common';
import { ENTRY_PROVIDER_WATERMARK } from '@nestjs/common/constants.js';
import { DiscoveryService, ModuleRef } from '@nestjs/core';
import {
  GraphQLSchemaHost,
  RESOLVER_NAME_METADATA,
  RESOLVER_PROPERTY_METADATA,
  RESOLVER_TYPE_METADATA,
  TypeMetadataStorage,
} from '@nestjs/graphql';
import {
  type GraphQLField,
  type GraphQLSchema,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
} from 'graphql';
import { PinoLogger } from 'nestjs-pino';
import 'reflect-metadata';
import { KNOWN_CLIENTS } from '../config/env.schema.js';
import { nameOf } from './checked-hook.js';
import { type ClientAvailability, clientAvailabilityOf } from './client-availability.decorator.js';
import { type AvailabilityRules, classChain, isAvailableTo } from './client-availability.guard.js';
import { fieldRulesOf } from './client-field-availability.js';

/**
 * Startup validation of `@ClientFeature` / `@ClientDisabled` on CLASSES and METHODS (what the
 * schema cannot show: `restrictClientFields` checks the fields themselves, when the schema is built).
 * Everything is collected and reported in one error, before the application serves anything.
 *
 * Not registered anywhere yet: listing it in `CustomizationsCoreModule` is part of the integration
 * step. It needs `DiscoveryModule` (imported by that module) and runs at `onApplicationBootstrap`,
 * when every provider and the GraphQL schema exist.
 *
 * Rejected (each is a restriction that would silently NOT apply, or apply to something it was not
 * meant for):
 * - a restriction on an HTTP controller, its class or its methods. The feature is GraphQL-only, and
 *   the global guard that reads the metadata also runs for HTTP;
 * - a restriction on a provider that is neither a controller nor a resolver (a service): it is not
 *   an endpoint, nothing reads it;
 * - on a resolver, a restricted METHOD that is not a `@Query`, `@Mutation`, `@Subscription` or
 *   `@ResolveField`: nothing reads it;
 * - on a resolver that has `@ResolveField` methods, a CLASS-level restriction (also an inherited
 *   one): Nest runs no guard on field resolvers, so they would stay available through any other
 *   query that returns the type. Restrict the fields, or the root methods, one by one;
 * - a restriction on the class of a GraphQL type (`@ObjectType`, `@InterfaceType`, `@InputType`):
 *   restrict its fields;
 * - a restriction on an `@ArgsType` class or one of its properties: Nest flattens it into the
 *   field's arguments and drops the extensions, so it would silently do nothing;
 * - a restricted field of a base type whose restriction is lost or WIDENED in a subclass that
 *   declares the same field again with `@Field` (under the same name or another): Nest replaces the
 *   base field together with its extensions. Repeat the restriction (a narrower one is accepted),
 *   or do not declare the field again. In an input type or an interface, where no restriction is
 *   supported, any restriction on a property of the chain is rejected, whether or not it survived;
 * - a restricted `@ResolveField` whose restriction does not reach the schema field. Nest drops the
 *   `@Extensions` of a field resolver when the type ALSO declares the same field with `@Field`
 *   (the type's own extensions win), so the restriction would silently not apply. The check looks
 *   the field up in the built schema and compares; put the decorator on the type's `@Field`
 *   instead. It cannot be done at decoration time, and it needs the schema, so it is skipped when
 *   the application has no GraphQL schema;
 * - malformed metadata (forged or damaged), and an allow-list together with a deny-list on one
 *   target (the decorators refuse that themselves, so this only catches metadata written by hand).
 *
 * Messages name classes and methods, never a value from the metadata.
 */
@Injectable()
export class ClientAvailabilityValidator implements OnApplicationBootstrap {
  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    // Not `@InjectPinoLogger`: see ClientSettingsService (provider order of nestjs-pino).
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(ClientAvailabilityValidator.name);
  }

  onApplicationBootstrap(): void {
    const problems = this.check();
    if (problems.length === 0) return;
    this.logger.error({ problems }, 'client availability validation failed');
    throw new Error(
      `Invalid client availability (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
    );
  }

  /** Every problem found, in discovery order; empty when the configuration is valid. */
  check(): string[] {
    const problems: string[] = [];
    const seen = new Set<object>();
    const schema = this.schema();
    const visit = (cls: unknown, kind: ClassKind): void => {
      if (typeof cls !== 'function' || seen.has(cls)) return;
      seen.add(cls);
      checkClass(cls, kind, schema, problems);
    };

    for (const wrapper of this.discovery.getControllers()) visit(classOf(wrapper), 'controller');
    for (const wrapper of this.discovery.getProviders()) {
      const cls = classOf(wrapper);
      if (typeof cls !== 'function') continue;
      visit(cls, Reflect.hasMetadata(ENTRY_PROVIDER_WATERMARK, cls) ? 'resolver' : 'provider');
    }
    for (const { cls, typeName } of typeClasses(schema)) {
      visit(cls, 'type');
      if (schema !== undefined) checkTypeFields(schema, cls, typeName, problems);
    }
    checkArgsTypes(problems);
    return problems;
  }

  /** The built schema, which exists before `onApplicationBootstrap`; none without GraphQL. */
  private schema(): GraphQLSchema | undefined {
    try {
      return this.moduleRef.get(GraphQLSchemaHost, { strict: false }).schema;
    } catch {
      return undefined;
    }
  }
}

type ClassKind = 'controller' | 'resolver' | 'provider' | 'type';

interface AnnotatedMethod {
  readonly owner: string;
  readonly key: string;
  readonly method: object;
}

/**
 * The class to inspect for a provider. A class provider has its `metatype`. A value or factory
 * provider has none, but Nest finds resolvers by the CLASS OF THE INSTANCE (`instance.constructor`),
 * so a resolver registered that way is inspected through its instance; plain objects are not classes
 * worth inspecting. Reading is by descriptor: no getter of the instance runs.
 */
function classOf(wrapper: {
  metatype?: unknown;
  isNotMetatype?: boolean;
  instance?: unknown;
}): unknown {
  if (wrapper.isNotMetatype !== true) return wrapper.metatype;
  try {
    const instance = wrapper.instance;
    if (typeof instance !== 'object' || instance === null) return undefined;
    const prototype: unknown = Object.getPrototypeOf(instance);
    if (typeof prototype !== 'object' || prototype === null) return undefined;
    const constructor: unknown = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
    return typeof constructor === 'function' && constructor !== Object ? constructor : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The classes of the GraphQL types that are IN the schema. `TypeMetadataStorage` is process-wide
 * and holds every type class that was ever loaded, so the schema decides which of them count; with
 * no schema (no GraphQL in this application) there are no types to check.
 */
function typeClasses(schema: GraphQLSchema | undefined): { cls: object; typeName: string }[] {
  if (schema === undefined) return [];
  try {
    return [
      ...TypeMetadataStorage.getObjectTypesMetadata(),
      ...TypeMetadataStorage.getInterfacesMetadata(),
      ...TypeMetadataStorage.getInputTypesMetadata(),
    ]
      .filter((metadata) => schema.getType(metadata.name) !== undefined)
      .flatMap((metadata) => {
        const cls: unknown = metadata.target;
        return typeof cls === 'function' ? [{ cls, typeName: metadata.name }] : [];
      });
  } catch {
    return [];
  }
}

function checkClass(
  cls: object,
  kind: ClassKind,
  schema: GraphQLSchema | undefined,
  problems: string[],
): void {
  const name = nameOf(cls) ?? '(anonymous class)';
  const { chain, complete } = classChain(cls);
  let classRestricted = false;
  let hasFieldResolver = false;
  const annotated: AnnotatedMethod[] = [];

  const read = (target: object, where: string): ClientAvailability | undefined => {
    try {
      const availability = clientAvailabilityOf(target);
      if (availability.feature && availability.disabled) {
        problems.push(
          `${where}: @ClientFeature and @ClientDisabled cannot both be used on one target`,
        );
      }
      return availability;
    } catch {
      problems.push(`${where}: the client availability metadata is malformed`);
      return undefined;
    }
  };

  for (const current of chain) {
    const own = read(current, nameOf(current) ?? '(anonymous class)');
    if (own?.feature || own?.disabled) classRestricted = true;
    const prototype: unknown = Object.getOwnPropertyDescriptor(current, 'prototype')?.value;
    if (typeof prototype !== 'object' || prototype === null) continue;
    for (const key of Reflect.ownKeys(prototype)) {
      if (key === 'constructor') continue;
      const method: unknown = Object.getOwnPropertyDescriptor(prototype, key)?.value;
      if (typeof method !== 'function') continue;
      if (Reflect.getMetadata(RESOLVER_PROPERTY_METADATA, method) === true) hasFieldResolver = true;
      const where = `${nameOf(current) ?? '(anonymous class)'}.${String(key)}`;
      const availability = read(method, where);
      if (availability?.feature || availability?.disabled) {
        annotated.push({ owner: nameOf(current) ?? '(anonymous class)', key: String(key), method });
      }
    }
  }
  if (!complete) {
    problems.push(
      `${name}: the class hierarchy could not be read, so its restrictions are unknown`,
    );
  }

  switch (kind) {
    case 'controller':
      if (classRestricted || annotated.length > 0) {
        problems.push(
          `${name}: client availability is GraphQL-only; remove @ClientFeature/@ClientDisabled from this HTTP controller`,
        );
      }
      break;
    case 'provider':
      if (classRestricted || annotated.length > 0) {
        problems.push(
          `${name}: client availability can only be used on a GraphQL resolver (or on a field of a GraphQL type), not on this provider`,
        );
      }
      break;
    case 'type':
      if (classRestricted) {
        problems.push(
          `${name}: a restriction on a GraphQL type class is not supported; restrict its fields instead`,
        );
      }
      break;
    case 'resolver':
      for (const { owner, key, method } of annotated) {
        if (!isEndpoint(method)) {
          problems.push(
            `${owner}.${key}: a restricted method must be a @Query, @Mutation, @Subscription or @ResolveField`,
          );
        } else if (
          schema !== undefined &&
          Reflect.getMetadata(RESOLVER_PROPERTY_METADATA, method)
        ) {
          const problem = fieldRestrictionProblem(schema, cls, key, method);
          if (problem) problems.push(`${owner}.${key}: ${problem}`);
        }
      }
      if (classRestricted && hasFieldResolver) {
        problems.push(
          `${name}: a class-level restriction does not apply to its @ResolveField methods (Nest runs no guard on them); restrict the fields or the root methods one by one`,
        );
      }
      break;
  }
}

/**
 * Is the restriction of the `@ResolveField` method `method` on the field of the schema it resolves?
 * `undefined` when it is, otherwise the problem. The field is found by the type name the resolver
 * was declared for (`@Resolver(() => Account)`) and the field name (`@ResolveField('name')`, else
 * the method name). A type or field that cannot be found is a problem too: then nothing proves the
 * restriction is enforced.
 */
function fieldRestrictionProblem(
  schema: GraphQLSchema,
  resolver: object,
  methodKey: string,
  method: object,
): string | undefined {
  const rules = clientAvailabilityOf(method);
  const named: unknown = Reflect.getMetadata(RESOLVER_NAME_METADATA, method);
  const fieldName = typeof named === 'string' && named !== '' ? named : methodKey;
  const fieldNames = new Set([fieldName]);
  for (const current of classChain(resolver).chain) {
    const prototype: unknown = Object.getOwnPropertyDescriptor(current, 'prototype')?.value;
    if (typeof prototype !== 'object' || prototype === null) continue;
    const definition: unknown = Object.getOwnPropertyDescriptor(prototype, methodKey)?.value;
    if (
      typeof definition !== 'function' ||
      Reflect.getMetadata(RESOLVER_PROPERTY_METADATA, definition) !== true
    )
      continue;
    const alias: unknown = Reflect.getMetadata(RESOLVER_NAME_METADATA, definition);
    fieldNames.add(typeof alias === 'string' && alias !== '' ? alias : methodKey);
  }
  const type = schema.getType(typeNameOf(schema, resolver) ?? '');
  for (const name of fieldNames) {
    const field = isObjectType(type) ? type.getFields()[name] : undefined;
    if (!field) {
      return 'the schema field it resolves could not be found, so its restriction cannot be verified';
    }
    if (isAtLeastAsStrict(field, rules)) continue;
    return 'the restriction did not reach the schema field. Nest drops the @Extensions of a @ResolveField when the type also declares the field with @Field; put @ClientFeature/@ClientDisabled on that @Field instead';
  }
  return undefined;
}

/**
 * Is the schema field AT LEAST as strict as `expected`: does every client the field lets through
 * also pass `expected`? Equal restrictions qualify, and so does a narrower field (a subclass that
 * narrows an allow-list is safe). A missing or wider restriction does not, and neither does an
 * unreadable one.
 */
function isAtLeastAsStrict(
  field: GraphQLField<unknown, unknown>,
  expected: ClientAvailability,
): boolean {
  let actual: AvailabilityRules | undefined;
  try {
    actual = fieldRulesOf(field.extensions);
  } catch {
    return false;
  }
  const wanted: AvailabilityRules = {
    feature: expected.feature ? [expected.feature] : [],
    disabled: expected.disabled ? [expected.disabled] : [],
  };
  return KNOWN_CLIENTS.every(
    (client) =>
      (actual !== undefined && !isAvailableTo(client, actual)) || isAvailableTo(client, wanted),
  );
}

/**
 * Property restrictions of the classes behind one GraphQL type of the schema.
 *
 * OBJECT type: every restriction that a PROPERTY of the class or of one of its ancestors carries
 * must still be on the schema field(s) of that property, at least as strict. It is not when a
 * subclass declares the field again (Nest replaces the inherited field and its extensions) without
 * the same restriction, or with a wider one.
 *
 * The property and its schema field are matched through Nest's per-class property metadata, because
 * `@Field({ name })` makes the two differ. A restricted property is compared with every schema field
 * it was declared as, in any class of the chain: the field it has (an alias under another name would
 * expose the data), and also the field whose NAME it had, which another property may have taken over.
 * Only a property with no declaration at all is taken to be named like its field.
 *
 * INPUT type or INTERFACE: no restriction is supported there, and the transform rejects one it
 * sees. But a subclass that declares the field again replaces the extension, so the restriction
 * would vanish before the transform could see it; the property metadata is therefore checked on
 * its own.
 */
function checkTypeFields(
  schema: GraphQLSchema,
  cls: object,
  typeName: string,
  problems: string[],
): void {
  const type = schema.getType(typeName);
  const { chain } = classChain(cls);
  const reported = new Set<string>();

  // property name -> schema names it was declared under, anywhere in the chain
  const declared = new Map<string, Set<string>>();
  for (const current of chain) {
    for (const { name, schemaName } of declaredPropertiesOf(current)) {
      declared.set(name, (declared.get(name) ?? new Set<string>()).add(schemaName));
    }
  }

  const restrictionsOf = (propertyName: string): { owner: string; rules: ClientAvailability }[] => {
    const found: { owner: string; rules: ClientAvailability }[] = [];
    for (const current of chain) {
      const prototype: unknown = Object.getOwnPropertyDescriptor(current, 'prototype')?.value;
      if (typeof prototype !== 'object' || prototype === null) continue;
      try {
        const rules = clientAvailabilityOf(prototype, propertyName);
        if (rules.feature || rules.disabled) {
          found.push({ owner: nameOf(current) ?? '(anonymous class)', rules });
        }
      } catch {
        reported.add(`${typeName}.${propertyName}: the client availability metadata is malformed`);
      }
    }
    return found;
  };

  if (isObjectType(type)) {
    const fields = type.getFields();
    for (const propertyName of new Set([...declared.keys(), ...Object.keys(fields)])) {
      const schemaNames = declared.get(propertyName) ?? new Set([propertyName]);
      for (const { owner, rules } of restrictionsOf(propertyName)) {
        for (const schemaName of schemaNames) {
          const field = fields[schemaName];
          if (field !== undefined && !isAtLeastAsStrict(field, rules)) {
            reported.add(
              `${typeName}.${schemaName}: the restriction declared on ${owner} is lost or widened in the schema; a subclass that declares the field again with @Field (under the same name or another) replaces or bypasses it, so repeat the same restriction (or a stricter one) or do not declare it again`,
            );
          }
        }
      }
    }
  } else if (isInputObjectType(type) || isInterfaceType(type)) {
    for (const [propertyName, schemaNames] of declared) {
      if (restrictionsOf(propertyName).length > 0) {
        reported.add(
          `${typeName}.${[...schemaNames][0]}: a restriction on a field of ${isInterfaceType(type) ? 'an interface' : 'an input type'} is not supported`,
        );
      }
    }
  }
  problems.push(...reported);
}

/** The `@Field` declarations of ONE class (not of its ancestors): property name and schema name. */
function declaredPropertiesOf(cls: object): { name: string; schemaName: string }[] {
  try {
    const target = cls as Type<unknown>;
    const metadata =
      TypeMetadataStorage.getObjectTypeMetadataByTarget(target) ??
      TypeMetadataStorage.getInputTypeMetadataByTarget(target) ??
      TypeMetadataStorage.getInterfaceMetadataByTarget(target);
    return (metadata?.properties ?? []).map(({ name, schemaName }) => ({ name, schemaName }));
  } catch {
    return [];
  }
}

/**
 * `@ArgsType` classes: Nest flattens one into the arguments of the field that uses it, keeping neither
 * the class nor the property extensions, so a restriction on the class or on a property would be
 * silently ignored. EVERY loaded `@ArgsType` class is checked, used or not: a restriction there is
 * a mistake wherever the class ends up, and the storage is process-wide, so "the ones this
 * application uses" cannot be told apart reliably. Ancestors are checked too.
 */
function checkArgsTypes(problems: string[]): void {
  let args: readonly { target: unknown; properties?: readonly { name: string }[] }[];
  try {
    args = TypeMetadataStorage.getArgumentsMetadata();
  } catch {
    return;
  }
  const restricted = (target: object, propertyKey?: string): boolean => {
    try {
      const rules = clientAvailabilityOf(target, propertyKey);
      return Boolean(rules.feature || rules.disabled);
    } catch {
      return true; // present and damaged: also not something to keep silently
    }
  };
  for (const metadata of args) {
    if (typeof metadata.target !== 'function') continue;
    const names = new Set((metadata.properties ?? []).map((property) => property.name));
    for (const current of classChain(metadata.target).chain) {
      const className = nameOf(current) ?? '(anonymous class)';
      if (restricted(current)) {
        problems.push(
          `${className}: client availability is not supported on an @ArgsType class (Nest does not carry it into arguments)`,
        );
      }
      const prototype: unknown = Object.getOwnPropertyDescriptor(current, 'prototype')?.value;
      if (typeof prototype !== 'object' || prototype === null) continue;
      for (const name of names) {
        if (restricted(prototype, name)) {
          problems.push(
            `${className}.${name}: client availability is not supported on an @ArgsType property (Nest does not carry field extensions into arguments)`,
          );
        }
      }
    }
  }
}

/** The GraphQL type a resolver class was declared for; it may differ from the class name (`@ObjectType('Name')`). */
function typeNameOf(schema: GraphQLSchema, resolver: object): string | undefined {
  const declared: unknown = Reflect.getMetadata(RESOLVER_NAME_METADATA, resolver);
  if (typeof declared !== 'string') return undefined;
  if (schema.getType(declared) !== undefined) return declared;
  try {
    return TypeMetadataStorage.getObjectTypesMetadata().find(
      (metadata) => nameOf(metadata.target) === declared,
    )?.name;
  } catch {
    return undefined;
  }
}

function isEndpoint(method: object): boolean {
  const type: unknown = Reflect.getMetadata(RESOLVER_TYPE_METADATA, method);
  return (
    type === 'Query' ||
    type === 'Mutation' ||
    type === 'Subscription' ||
    Reflect.getMetadata(RESOLVER_PROPERTY_METADATA, method) === true
  );
}
