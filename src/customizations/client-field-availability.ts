import { NotFoundException } from '@nestjs/common';
import {
  type GraphQLField,
  type GraphQLInputField,
  type GraphQLNamedType,
  type GraphQLSchema,
  isInputObjectType,
  isInterfaceType,
  isNonNullType,
  isObjectType,
} from 'graphql';
import { KNOWN_CLIENTS, type ClientCode } from '../config/env.schema.js';
import {
  CLIENT_DISABLED_KEY,
  CLIENT_FEATURE_KEY,
  parseClientList,
} from './client-availability.decorator.js';
import { type AvailabilityRules, isAvailableTo } from './client-availability.guard.js';

/**
 * Per-client availability of single GraphQL FIELDS (a plain `@Field` and a `@ResolveField`).
 *
 * Why not a guard: Nest runs no guard on a field resolver, and turning `fieldResolverEnhancers` on
 * would run every global guard (JWT check, permission check) on every field of the API. Instead the
 * decorators write a field extension (`@ClientFeature` / `@ClientDisabled`, see there) and this
 * function, given to the GraphQL module as `transformSchema`, acts on exactly those fields once,
 * when the schema is built:
 *
 *   transformSchema: restrictClientFields(config.client)
 *
 * - A field the configured client may use is NOT touched: its resolver is the one Nest built, and
 *   behaves exactly as without this function (parent, arguments, context and info included).
 * - A field the client may NOT use gets a resolver that throws `NotFoundException` and never calls
 *   the original one: the resolver method does not run, nothing it would have read is touched. The
 *   client is fixed for the whole deployment (`AppConfig.client`), so this is decided here, once,
 *   not on every request.
 * - Every other field is not looked at beyond reading its extensions. The schema's shape is not
 *   changed: the printed schema (`schema.graphql`) is identical with and without this function,
 *   and the hidden field stays visible to introspection (one shared schema).
 *
 * Using Nest's `NotFoundException` keeps NOT_FOUND mapping in the shared GraphQL formatter and
 * lets the shared logging plugin classify the denial as an HTTP 404 client error.
 *
 * Root fields (Query, Mutation, Subscription) are the guard's business (`ClientAvailabilityGuard`,
 * which runs before authentication) and are left alone here: a subscription field would need its
 * `subscribe` function wrapped too, and a guard already covers all three.
 *
 * Startup validation: the transform checks every restriction it finds and throws ONE error listing
 * all problems, so a mistake stops the application when the schema is built, and not at the first
 * request. Checked: the extension is well formed (known clients, a non-empty list) and does not
 * carry both an allow-list and a deny-list; the field is nullable (a denial of a non-null field
 * would null the whole parent object, and the parent's parent, up to a non-null ancestor); and the
 * field belongs to an object type (an interface or an input type field cannot be restricted).
 * Messages name types and fields, never a value from the extensions.
 */
export function restrictClientFields(client: ClientCode): (schema: GraphQLSchema) => GraphQLSchema {
  if (!KNOWN_CLIENTS.includes(client)) {
    throw new TypeError('restrictClientFields() needs a known client');
  }
  return (schema) => {
    const roots = new Set<GraphQLNamedType>(
      [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()].filter(
        (type): type is NonNullable<typeof type> => type != null,
      ),
    );
    const problems: string[] = [];
    const denied: GraphQLField<unknown, unknown>[] = [];

    for (const type of Object.values(schema.getTypeMap())) {
      if (type.name.startsWith('__')) continue;
      if (!isObjectType(type) && !isInterfaceType(type) && !isInputObjectType(type)) continue;
      // `getFields()` of the three type kinds is a union that `Object.values` cannot take as is.
      const fields = Object.values(
        type.getFields() as Record<string, GraphQLField<unknown, unknown> | GraphQLInputField>,
      );
      for (const field of fields) {
        const where = `${type.name}.${field.name}`;
        let rules: AvailabilityRules | undefined;
        try {
          rules = fieldRulesOf(field.extensions);
        } catch (error) {
          problems.push(`${where}: ${(error as Error).message}`);
          continue;
        }
        if (rules === undefined) continue;
        if (!isObjectType(type)) {
          problems.push(
            `${where}: a restriction is only supported on a field of an object type, not on a field of an ${isInterfaceType(type) ? 'interface' : 'input type'}`,
          );
        } else if (roots.has(type)) {
          continue; // a root endpoint: the guard's business
        } else if (isNonNullType(field.type)) {
          problems.push(
            `${where}: a restricted field must be nullable, or a denial would null the whole parent object`,
          );
        } else if (!isAvailableTo(client, rules)) {
          denied.push(field as GraphQLField<unknown, unknown>);
        }
      }
    }

    if (problems.length > 0) {
      throw new Error(
        `Invalid client availability on GraphQL fields (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
      );
    }
    // Nothing is changed before every field has been checked.
    for (const field of denied) {
      field.resolve = (): never => {
        throw new NotFoundException();
      };
    }
    return schema;
  };
}

/**
 * The restriction a field's `extensions` carry, in the shape `isAvailableTo` takes, or `undefined`
 * when it carries none. Throws a `TypeError` (fixed message, no value) for a malformed list, or
 * for both an allow-list and a deny-list on one field.
 */
export function fieldRulesOf(
  extensions: Readonly<Record<string, unknown>> | undefined,
): AvailabilityRules | undefined {
  const has = (key: string): boolean => extensions !== undefined && Object.hasOwn(extensions, key);
  const hasFeature = has(CLIENT_FEATURE_KEY);
  const hasDisabled = has(CLIENT_DISABLED_KEY);
  if (!hasFeature && !hasDisabled) return undefined;
  if (hasFeature && hasDisabled) {
    throw new TypeError('@ClientFeature and @ClientDisabled cannot both be used on one field');
  }
  const stored = (key: string): unknown => (extensions as Record<string, unknown>)[key];
  return hasFeature
    ? { feature: [parseClientList('ClientFeature', stored(CLIENT_FEATURE_KEY))], disabled: [] }
    : { feature: [], disabled: [parseClientList('ClientDisabled', stored(CLIENT_DISABLED_KEY))] };
}
