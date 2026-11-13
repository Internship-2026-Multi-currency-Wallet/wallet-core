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
import { formatError, formatExecutionResult } from './format-error.js';

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

describe('formatError: Nest HttpException', () => {
  const location = { line: 2, column: 3 };

  it.each([
    ['400', new BadRequestException('bad'), 'BAD_REQUEST'],
    ['401', new UnauthorizedException('Authentication required'), 'UNAUTHENTICATED'],
    ['403', new ForbiddenException('Missing permission: wallet'), 'FORBIDDEN'],
    ['404', new NotFoundException(), 'NOT_FOUND'],
    ['422', new UnprocessableEntityException(), 'BAD_USER_INPUT'],
  ])('gives a %s the code of its status', (_status, exc, code) => {
    const error = thrownInResolver(exc);
    // Over graphql-ws the formatted error has no code; over http it has the one @nestjs/apollo set.
    for (const formatted of [error.toJSON(), { ...error.toJSON(), extensions: { code } }]) {
      expect(formatError(formatted, error)).toEqual({
        message: exc.message,
        path: ['register'],
        extensions: { code },
      });
    }
  });

  it('gives a plain HttpException the code of its status too', () => {
    const error = thrownInResolver(new HttpException('Nope', 401));
    expect(formatError(error.toJSON(), error).extensions?.code).toBe('UNAUTHENTICATED');
  });

  it('leaves a status without a code in the table unchanged', () => {
    const exc = new InternalServerErrorException();
    const formatted = { message: exc.message, extensions: { code: 'INTERNAL_SERVER_ERROR' } };
    expect(formatError(formatted, thrownInResolver(exc))).toBe(formatted);
  });

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
  it('maps a wrapped ForbiddenException to FORBIDDEN', () => {
    const error = new GraphQLError('Missing permission: wallet', {
      path: ['balanceChanged'],
      originalError: new ForbiddenException('Missing permission: wallet'),
    });

    expect(formatExecutionResult({ data: null, errors: [error] })?.errors).toEqual([
      {
        message: 'Missing permission: wallet',
        path: ['balanceChanged'],
        extensions: { code: 'FORBIDDEN' },
      },
    ]);
  });

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
});
