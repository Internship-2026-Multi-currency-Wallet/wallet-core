import { UnauthorizedException } from '@nestjs/common';
import { GraphQLError, buildSchema, graphqlSync } from 'graphql';
import { formatError } from './format-error.js';

/** What Apollo does with an error thrown in a resolver: wraps it with the path. */
function thrownInResolver(error: Error): GraphQLError {
  return new GraphQLError(error.message, { path: ['register'], originalError: error });
}

describe('formatError', () => {
  it('hides the message of an unexpected error', () => {
    const dbError = new Error(
      "insert into `users` values ('artem@test.com', '$argon2id$...') - boom",
    );
    const error = thrownInResolver(dbError);
    const formatted = {
      ...error.toJSON(),
      extensions: { code: 'INTERNAL_SERVER_ERROR', stacktrace: ['at ...'] },
    };

    expect(formatError(formatted, error)).toEqual({
      message: 'Internal server error',
      path: ['register'],
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });

  it('keeps a GraphQLError thrown on purpose', () => {
    const error = thrownInResolver(
      new GraphQLError('Invalid email or password', {
        extensions: { code: 'INVALID_CREDENTIALS' },
      }),
    );
    const formatted = error.toJSON();
    expect(formatError(formatted, error)).toBe(formatted);
  });

  it('keeps a Nest HttpException (already mapped to its code by Nest)', () => {
    const error = thrownInResolver(new UnauthorizedException());
    const formatted = { message: 'Unauthorized', extensions: { code: 'UNAUTHENTICATED' } };
    expect(formatError(formatted, error)).toBe(formatted);
  });

  it('keeps errors raised by GraphQL itself (parse, validation)', () => {
    const error = new GraphQLError('Cannot query field "nope" on type "Query".', {
      extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
    });
    const formatted = error.toJSON();
    expect(formatError(formatted, error)).toBe(formatted);
  });

  it('hides a GraphQLError without a code, e.g. a value GraphQL could not serialize', () => {
    const schema = buildSchema('type Query { me: String }');
    const leaked = { email: 'artem@test.com', password_hash: '$argon2id$...' };
    const result = graphqlSync({ schema, source: '{ me }', rootValue: { me: () => leaked } });
    const [error] = result.errors ?? [];
    expect(error.message).toContain('artem@test.com');

    const formatted = { ...error.toJSON(), extensions: { code: 'INTERNAL_SERVER_ERROR' } };
    expect(formatError(formatted, error)).toEqual({
      message: 'Internal server error',
      locations: error.locations,
      path: ['me'],
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });
});
