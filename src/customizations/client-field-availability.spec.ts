import { NotFoundException } from '@nestjs/common';
import { jest } from '@jest/globals';
import {
  type GraphQLFieldConfig,
  type GraphQLFieldResolver,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  graphql,
} from 'graphql';
import type { ClientCode } from '../config/env.schema.js';
import { CLIENT_DISABLED_KEY, CLIENT_FEATURE_KEY } from './client-availability.decorator.js';
import { fieldRulesOf, restrictClientFields } from './client-field-availability.js';

/**
 * `restrictClientFields` on hand-built graphql-js schemas: no Nest, no decorators. The decorators
 * and a booted application are covered by `client-field-availability.integration.spec.ts`.
 */

type Extensions = Record<string, unknown>;
type Resolve = GraphQLFieldResolver<unknown, unknown>;

const WISLA_ONLY: Extensions = { [CLIENT_FEATURE_KEY]: ['wisla'] };
const NOT_FOR_WISLA: Extensions = { [CLIENT_DISABLED_KEY]: ['wisla'] };

const field = (
  extensions?: Extensions,
  resolve?: Resolve,
  type: GraphQLFieldConfig<unknown, unknown>['type'] = GraphQLString,
): GraphQLFieldConfig<unknown, unknown> => ({ type, extensions, resolve });

/** A schema with a root `Query.thing` of an object type `Thing` that has the given fields. */
function schemaWith(
  fields: Record<string, GraphQLFieldConfig<unknown, unknown>>,
  rootFields: Record<string, GraphQLFieldConfig<unknown, unknown>> = {},
): GraphQLSchema {
  const thing = new GraphQLObjectType({ name: 'Thing', fields });
  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: { thing: { type: thing, resolve: () => ({}) }, ...rootFields },
    }),
  });
}

const thingField = (schema: GraphQLSchema, name: string) =>
  (schema.getType('Thing') as GraphQLObjectType).getFields()[name];

const apply = (client: ClientCode, schema: GraphQLSchema): GraphQLSchema =>
  restrictClientFields(client)(schema);

describe('restrictClientFields', () => {
  describe('a field the client may not use', () => {
    it('gets a resolver that throws NotFoundException and never calls the original', () => {
      const original = jest.fn<Resolve>(() => 'secret');
      const schema = apply('kvitka', schemaWith({ hidden: field(WISLA_ONLY, original) }));
      const resolve = thingField(schema, 'hidden')?.resolve as Resolve;

      expect(() => resolve({}, {}, {}, {} as never)).toThrow(NotFoundException);
      expect(original).not.toHaveBeenCalled();
    });

    it('also works for a field with no resolver at all (a plain @Field property)', async () => {
      const schema = apply('kvitka', schemaWith({ id: field(), note: field(WISLA_ONLY) }));
      const result = await graphql({
        schema,
        source: '{ thing { id note } }',
        // Stands in for graphql-js's default resolver, which reads the property of the parent.
        fieldResolver: (_source, _args, _context, info) => `value of ${info.fieldName}`,
      });
      expect(result.data).toEqual({ thing: { id: 'value of id', note: null } });
      expect(result.errors?.map((error) => error.path)).toEqual([['thing', 'note']]);
    });

    it('answers a partial response: the field is null, with an error at its path', async () => {
      const schema = apply(
        'kvitka',
        schemaWith({
          open: field(undefined, () => 'open'),
          hidden: field(WISLA_ONLY, () => 'secret'),
        }),
      );
      const result = await graphql({ schema, source: '{ thing { open hidden } }' });
      expect(result.data).toEqual({ thing: { open: 'open', hidden: null } });
      expect(result.errors).toHaveLength(1);
      expect(result.errors?.[0]?.path).toEqual(['thing', 'hidden']);
      expect(result.errors?.[0]?.originalError).toBeInstanceOf(NotFoundException);
      expect(result.errors?.[0]?.message).toBe('Not Found');
    });

    it('is hidden by a deny-list for a listed client, and by an allow-list for an unlisted one', () => {
      const build = () =>
        schemaWith({ denied: field(NOT_FOR_WISLA, () => 'x'), only: field(WISLA_ONLY, () => 'x') });
      const forWisla = apply('wisla', build());
      const forKvitka = apply('kvitka', build());
      const throws = (schema: GraphQLSchema, name: string): boolean => {
        try {
          (thingField(schema, name)?.resolve as Resolve)({}, {}, {}, {} as never);
          return false;
        } catch (error) {
          return error instanceof NotFoundException;
        }
      };
      expect(throws(forWisla, 'denied')).toBe(true);
      expect(throws(forWisla, 'only')).toBe(false);
      expect(throws(forKvitka, 'denied')).toBe(false);
      expect(throws(forKvitka, 'only')).toBe(true);
    });
  });

  describe('a field the client may use, and fields without a restriction', () => {
    it('keeps the very same resolver function, so parent, args, context and info are untouched', async () => {
      const seen: unknown[][] = [];
      const resolve: Resolve = (...args) => {
        seen.push(args);
        return 'ok';
      };
      const plain: Resolve = () => 'plain';
      const schema = schemaWith({
        allowed: field(WISLA_ONLY, resolve),
        plain: field(undefined, plain),
        other: field({ unrelated: true }, plain),
      });
      const before = {
        allowed: thingField(schema, 'allowed')?.resolve,
        plain: thingField(schema, 'plain')?.resolve,
        other: thingField(schema, 'other')?.resolve,
      };
      apply('wisla', schema);

      expect(thingField(schema, 'allowed')?.resolve).toBe(before.allowed);
      expect(thingField(schema, 'allowed')?.resolve).toBe(resolve);
      expect(thingField(schema, 'plain')?.resolve).toBe(before.plain);
      expect(thingField(schema, 'other')?.resolve).toBe(before.other);

      const context = { request: 1 };
      const result = await graphql({
        schema,
        source: '{ thing { allowed } }',
        contextValue: context,
        rootValue: {},
      });
      expect(result).toEqual({ data: { thing: { allowed: 'ok' } } });
      expect(seen[0]?.[2]).toBe(context);
      expect((seen[0]?.[3] as { fieldName: string }).fieldName).toBe('allowed');
    });

    it('leaves a field with no resolver without one (the default resolver still applies)', () => {
      const schema = schemaWith({ note: field(WISLA_ONLY) });
      apply('wisla', schema);
      expect(thingField(schema, 'note')?.resolve).toBeUndefined();
    });

    it('returns the schema it was given, with the extensions still in place, for any client', () => {
      const build = () =>
        schemaWith(
          { a: field(WISLA_ONLY), b: field(NOT_FOR_WISLA), c: field() },
          { rootOnly: field(WISLA_ONLY) },
        );
      for (const client of ['kvitka', 'wisla', 'demo'] as const) {
        const schema = build();
        expect(apply(client, schema)).toBe(schema);
        expect(thingField(schema, 'a')?.extensions).toEqual(WISLA_ONLY);
      }
    });
  });

  describe('root fields', () => {
    it('are left to the guard: a restricted Query field keeps its resolver for every client', () => {
      const resolve: Resolve = () => 'root';
      const schema = schemaWith({}, { guarded: field(WISLA_ONLY, resolve) });
      apply('kvitka', schema);
      expect(schema.getQueryType()?.getFields().guarded?.resolve).toBe(resolve);
    });

    it('may be non-null: the nullability rule applies to fields of other types only', () => {
      const schema = schemaWith(
        {},
        { guarded: field(WISLA_ONLY, () => 'x', new GraphQLNonNull(GraphQLString)) },
      );
      expect(() => apply('kvitka', schema)).not.toThrow();
    });

    it('still report a malformed restriction on a root field', () => {
      const schema = schemaWith({}, { guarded: field({ [CLIENT_FEATURE_KEY]: ['nope'] }) });
      expect(() => apply('kvitka', schema)).toThrow(/Query\.guarded/);
    });
  });

  describe('startup validation: one error, all problems, nothing changed', () => {
    const SECRET = 'sk_live_AbC123xyz789';

    it('rejects a non-null restricted field, and says why', () => {
      const schema = schemaWith({
        required: field(WISLA_ONLY, undefined, new GraphQLNonNull(GraphQLString)),
      });
      expect(() => apply('wisla', schema)).toThrow(
        'Invalid client availability on GraphQL fields (1 problem):\n- Thing.required: a restricted field must be nullable, or a denial would null the whole parent object',
      );
    });

    it('rejects it for EVERY client, also one that may use the field (it fails at startup, not when a client is denied)', () => {
      for (const client of ['kvitka', 'wisla', 'demo'] as const) {
        const schema = schemaWith({
          required: field(WISLA_ONLY, undefined, new GraphQLNonNull(GraphQLString)),
        });
        expect(() => apply(client, schema)).toThrow(/must be nullable/);
      }
    });

    it('rejects a list field that is non-null as a whole, accepts a nullable list of non-null items', () => {
      const nonNullList = schemaWith({
        list: field(WISLA_ONLY, undefined, new GraphQLNonNull(new GraphQLList(GraphQLString))),
      });
      expect(() => apply('kvitka', nonNullList)).toThrow(
        /Thing\.list: a restricted field must be nullable/,
      );
      const nullableList = schemaWith({
        list: field(WISLA_ONLY, undefined, new GraphQLList(new GraphQLNonNull(GraphQLString))),
      });
      expect(() => apply('kvitka', nullableList)).not.toThrow();
    });

    it('rejects a field on an interface or an input type', () => {
      const iface = new GraphQLInterfaceType({
        name: 'Node',
        fields: { id: { type: GraphQLString, extensions: WISLA_ONLY } },
      });
      const input = new GraphQLInputObjectType({
        name: 'Filter',
        fields: { by: { type: GraphQLString, extensions: WISLA_ONLY } },
      });
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: {
            n: {
              type: GraphQLString,
              args: { filter: { type: input } },
            },
          },
        }),
        types: [iface],
      });
      expect(() => apply('kvitka', schema)).toThrow(
        /Filter\.by: a restriction is only supported on a field of an object type, not on a field of an input type/,
      );
      expect(() => apply('kvitka', schema)).toThrow(/Node\.id: .* not on a field of an interface/);
    });

    it('rejects malformed lists and an allow-list together with a deny-list', () => {
      const schema = schemaWith({
        unknownClient: field({ [CLIENT_FEATURE_KEY]: ['nope'] }),
        empty: field({ [CLIENT_DISABLED_KEY]: [] }),
        notAList: field({ [CLIENT_FEATURE_KEY]: 'wisla' }),
        both: field({ [CLIENT_FEATURE_KEY]: ['wisla'], [CLIENT_DISABLED_KEY]: ['demo'] }),
      });
      let message = '';
      try {
        apply('kvitka', schema);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('(4 problems)');
      expect(message).toContain(
        '- Thing.unknownClient: @ClientFeature metadata is malformed: expected a non-empty list of known clients',
      );
      expect(message).toContain(
        '- Thing.empty: @ClientDisabled metadata is malformed: expected a non-empty list of known clients',
      );
      expect(message).toContain('- Thing.notAList: @ClientFeature metadata is malformed');
      expect(message).toContain(
        '- Thing.both: @ClientFeature and @ClientDisabled cannot both be used on one field',
      );
    });

    it('reports every problem at once and changes no field when there is one', () => {
      const resolve: Resolve = () => 'x';
      const schema = schemaWith({
        fine: field(WISLA_ONLY, resolve), // denied for kvitka, and valid
        required: field(WISLA_ONLY, undefined, new GraphQLNonNull(GraphQLString)),
        broken: field({ [CLIENT_FEATURE_KEY]: [] }),
      });
      expect(() => apply('kvitka', schema)).toThrow(/\(2 problems\)/);
      expect(thingField(schema, 'fine')?.resolve).toBe(resolve);
    });

    it('never repeats a value from the extensions', () => {
      const schema = schemaWith({
        leaky: field({ [CLIENT_FEATURE_KEY]: [SECRET, { token: SECRET }] }),
        both: field({ [CLIENT_FEATURE_KEY]: [SECRET], [CLIENT_DISABLED_KEY]: [SECRET] }),
      });
      try {
        apply('kvitka', schema);
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as Error).message).not.toContain(SECRET);
        expect((error as Error).message).toContain('Thing.leaky');
      }
    });

    it('rejects an unknown client for the transform itself (plain JavaScript or a cast)', () => {
      expect(() => restrictClientFields('nope' as ClientCode)).toThrow(
        new TypeError('restrictClientFields() needs a known client'),
      );
    });
  });
});

describe('fieldRulesOf', () => {
  it('says nothing for no extensions, or extensions that are not ours', () => {
    expect(fieldRulesOf(undefined)).toBeUndefined();
    expect(fieldRulesOf({})).toBeUndefined();
    expect(fieldRulesOf({ complexity: 1, audit: 'x' })).toBeUndefined();
  });

  it('turns an allow-list or a deny-list into the shape isAvailableTo takes', () => {
    expect(fieldRulesOf(WISLA_ONLY)).toEqual({ feature: [['wisla']], disabled: [] });
    expect(fieldRulesOf({ [CLIENT_DISABLED_KEY]: ['kvitka', 'demo'] })).toEqual({
      feature: [],
      disabled: [['kvitka', 'demo']],
    });
  });

  it('ignores a key that is only inherited, not the extensions object own', () => {
    expect(fieldRulesOf(Object.create(WISLA_ONLY) as Extensions)).toBeUndefined();
  });

  it('throws on both lists, and on a malformed one, with fixed messages', () => {
    expect(() =>
      fieldRulesOf({ [CLIENT_FEATURE_KEY]: ['wisla'], [CLIENT_DISABLED_KEY]: ['demo'] }),
    ).toThrow(new TypeError('@ClientFeature and @ClientDisabled cannot both be used on one field'));
    expect(() => fieldRulesOf({ [CLIENT_DISABLED_KEY]: undefined })).toThrow(
      new TypeError(
        '@ClientDisabled metadata is malformed: expected a non-empty list of known clients',
      ),
    );
  });
});
