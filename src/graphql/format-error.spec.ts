import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { GraphQLError, buildSchema, graphqlSync } from 'graphql';
import { formatError, formatExecutionResult, formatProtocolErrors } from './format-error.js';

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

describe('formatError: HTTP 404', () => {
  const location = { line: 2, column: 3 };

  it.each([
    ['NotFoundException', new NotFoundException('Customization not found')],
    ['HttpException with status 404', new HttpException('Customization not found', 404)],
  ])('maps %s to NOT_FOUND over http, replacing the code @nestjs/apollo gave it', (_name, exc) => {
    const error = thrownInResolver(exc);
    // Approximates the NotFoundException case: @nestjs/apollo's INTERNAL_SERVER_ERROR + status 404.
    // A plain HttpException('x', 404) would arrive with Apollo's default code and no status.
    const formatted = {
      message: 'Customization not found',
      locations: [location],
      path: ['register'],
      extensions: { code: 'INTERNAL_SERVER_ERROR', status: 404, stacktrace: ['at ...'] },
    };

    expect(formatError(formatted, error)).toEqual({
      message: 'Customization not found',
      locations: [location],
      path: ['register'],
      extensions: { code: 'NOT_FOUND', status: 404, stacktrace: ['at ...'] },
    });
  });

  it('maps a 404 whose formatted error has no extensions', () => {
    const error = thrownInResolver(new NotFoundException('Nope'));
    expect(formatError({ message: 'Nope', path: ['register'] }, error)).toEqual({
      message: 'Nope',
      path: ['register'],
      extensions: { code: 'NOT_FOUND' },
    });
  });

  it('keeps the path and locations of the original error', () => {
    const schema = buildSchema('type Query { customization: String }');
    const result = graphqlSync({
      schema,
      source: '{\n  customization\n}',
      rootValue: {
        customization: () => {
          throw new NotFoundException('Customization not found');
        },
      },
    });
    const [error] = result.errors ?? [];

    const formatted = formatError(error.toJSON(), error);
    expect(formatted.path).toEqual(['customization']);
    expect(formatted.locations).toEqual([{ line: 2, column: 3 }]);
    expect(formatted.extensions?.code).toBe('NOT_FOUND');
  });

  it.each([
    ['400', new BadRequestException('bad'), 'BAD_REQUEST'],
    ['401', new UnauthorizedException(), 'UNAUTHENTICATED'],
    ['403', new ForbiddenException(), 'FORBIDDEN'],
    ['422', new UnprocessableEntityException(), 'BAD_USER_INPUT'],
    ['500', new InternalServerErrorException(), 'INTERNAL_SERVER_ERROR'],
  ])('leaves a %s HttpException unchanged', (_status, exc, code) => {
    const formatted = { message: exc.message, extensions: { code } };
    expect(formatError(formatted, thrownInResolver(exc))).toBe(formatted);
  });

  it('still masks a raw error that merely mentions 404', () => {
    const error = thrownInResolver(new Error('select * from `secrets` - 404'));
    expect(formatError({ message: error.message, path: ['register'] }, error)).toEqual({
      message: 'Internal server error',
      path: ['register'],
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });

  it('keeps the code of a GraphQLError that already carries NOT_FOUND', () => {
    const error = new GraphQLError('Missing', { extensions: { code: 'NOT_FOUND' } });
    const formatted = error.toJSON();
    expect(formatError(formatted, error)).toBe(formatted);
  });
});

describe('formatExecutionResult', () => {
  it('maps a wrapped NotFoundException to NOT_FOUND', () => {
    const error = new GraphQLError('Customization not found', {
      path: ['register'],
      originalError: new NotFoundException('Customization not found'),
    });

    expect(formatExecutionResult({ data: null, errors: [error] })).toEqual({
      data: null,
      errors: [
        {
          message: 'Customization not found',
          path: ['register'],
          extensions: { code: 'NOT_FOUND' },
        },
      ],
    });
  });

  it('still masks an unexpected error', () => {
    const error = new GraphQLError('boom: select 1', {
      path: ['register'],
      originalError: new Error('boom: select 1'),
    });

    expect(formatExecutionResult({ data: null, errors: [error] })?.errors).toEqual([
      {
        message: 'Internal server error',
        path: ['register'],
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      },
    ]);
  });

  it('leaves a result without errors unchanged', () => {
    expect(formatExecutionResult({ data: { ok: true } })).toBeUndefined();
  });

  const schema = buildSchema('type Query { ok(flag: Boolean): Boolean }');
  it.each([
    ['a missing required variable', undefined, 'of required type "Boolean!" was not provided'],
    ['a variable of the wrong type', { b: 'yes' }, 'got invalid value "yes"; Boolean cannot'],
  ])('keeps %s as GRAPHQL_VALIDATION_FAILED', (_case, variableValues, explanation) => {
    const result = graphqlSync({
      schema,
      source: 'query V($b: Boolean!) { ok(flag: $b) }',
      variableValues,
    });
    const [error] = result.errors ?? [];
    expect(error.path).toBeUndefined();
    const extensions = { ...error.extensions };

    expect(formatExecutionResult(result)).toEqual({
      errors: [
        {
          message: expect.stringContaining(explanation),
          locations: [{ line: 1, column: 9 }],
          extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
        },
      ],
    });
    expect(error.extensions).toEqual(extensions);
  });

  it('keeps the string code, other extensions and result fields of a coercion error', () => {
    const error = new GraphQLError('Variable "$b" got invalid value', {
      extensions: { code: 'SCALAR_REJECTED', hint: 'use a boolean' },
    });

    expect(formatExecutionResult({ data: null, errors: [error], extensions: { cost: 1 } })).toEqual(
      {
        data: null,
        errors: [
          {
            message: 'Variable "$b" got invalid value',
            extensions: { code: 'SCALAR_REJECTED', hint: 'use a boolean' },
          },
        ],
        extensions: { cost: 1 },
      },
    );
    expect(error.extensions).toEqual({ code: 'SCALAR_REJECTED', hint: 'use a boolean' });
  });

  it('replaces a code that is not a string, keeping other extensions', () => {
    const error = new GraphQLError('Variable "$b" got invalid value', {
      extensions: { code: 42, hint: 'use a boolean' },
    });

    expect(formatExecutionResult({ errors: [error] })?.errors).toEqual([
      {
        message: 'Variable "$b" got invalid value',
        extensions: { code: 'GRAPHQL_VALIDATION_FAILED', hint: 'use a boolean' },
      },
    ]);
    expect(error.extensions).toEqual({ code: 42, hint: 'use a boolean' });
  });
});

describe('formatProtocolErrors: a running subscription that threw', () => {
  /** How graphql-ws reports it: a pathless wrapper of the thrown error. */
  const fromStream = (thrown: Error) => new GraphQLError(thrown.message, { originalError: thrown });

  it('keeps a thrown coded GraphQLError with its own path and cause, without unwrapping it', () => {
    const coded = new GraphQLError('Business refused', {
      path: ['upstream'],
      originalError: new Error('private cause'),
      extensions: { code: 'BUSINESS_REFUSAL' },
    });

    const [item] = formatProtocolErrors([fromStream(coded)]);

    expect(item).toEqual({
      error: { message: 'Business refused', extensions: { code: 'BUSINESS_REFUSAL' } },
      fromClient: false,
    });
    expect(JSON.stringify(item)).not.toContain('private cause');
  });

  it('masks a plain Error tagged with a code', () => {
    const tagged = Object.assign(new Error('private cause'), {
      extensions: { code: 'BUSINESS_REFUSAL' },
    });

    expect(formatProtocolErrors([fromStream(tagged)])).toEqual([
      {
        error: { message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
        fromClient: false,
      },
    ]);
  });

  it('maps a thrown 404 HttpException to NOT_FOUND', () => {
    const [item] = formatProtocolErrors([fromStream(new NotFoundException())]);
    expect(item.error.extensions?.code).toBe('NOT_FOUND');
  });
});
