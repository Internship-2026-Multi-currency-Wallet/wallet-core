import { buildSchema, parse, validate } from 'graphql';
import { maxDepthRule } from './max-depth.rule.js';

const schema = buildSchema(`
  type Query { a: A, n: Int }
  type A { b: A, n: Int }
`);

function errorsOf(query: string, maxDepth: number): string[] {
  return validate(schema, parse(query), [maxDepthRule(maxDepth)]).map((error) => error.message);
}

describe('maxDepthRule', () => {
  it('counts a leaf field as 1', () => {
    expect(errorsOf('{ n }', 1)).toEqual([]);
    expect(errorsOf('{ n }', 0)).toEqual(['Query depth 1 exceeds the limit of 0']);
  });

  it('adds 1 for each nested field with a selection set', () => {
    expect(errorsOf('{ a { b { n } } }', 3)).toEqual([]);
    expect(errorsOf('{ a { b { n } } }', 2)).toEqual(['Query depth 3 exceeds the limit of 2']);
  });

  it('measures the deepest field, not the first', () => {
    expect(errorsOf('{ n a { n } a { b { n } } }', 3)).toEqual([]);
  });

  it('adds no depth for inline fragments', () => {
    expect(errorsOf('{ a { ... on A { b { n } } } }', 3)).toEqual([]);
    expect(errorsOf('{ a { ... { b { n } } } }', 2)).toHaveLength(1);
  });

  it('follows fragment spreads without adding depth for the spread', () => {
    const query = 'query { a { ...F } } fragment F on A { b { n } }';
    expect(errorsOf(query, 3)).toEqual([]);
    expect(errorsOf(query, 2)).toEqual(['Query depth 3 exceeds the limit of 2']);
  });

  it('checks each operation on its own', () => {
    const query = 'query One { n } query Two { a { b { n } } }';
    expect(errorsOf(query, 2)).toEqual(['Query depth 3 exceeds the limit of 2']);
  });

  it('terminates on fragment cycles', () => {
    const query = 'query { a { ...F } } fragment F on A { b { ...G } } fragment G on A { ...F }';
    expect(() => errorsOf(query, 15)).not.toThrow();
  });

  it('ignores a spread of an unknown fragment', () => {
    expect(errorsOf('{ a { ...Missing } }', 2)).toEqual([]);
  });
});
