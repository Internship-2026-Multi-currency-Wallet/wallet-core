import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { type ArgumentsHost, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
// Not public API: pins the "undefined = not handled" contract the filter relies on.
import { ExternalExceptionsHandler } from '@nestjs/core/exceptions/external-exceptions-handler.js';
import { GraphQLError } from 'graphql';
import { ExpectedGraphqlErrorFilter, isExpectedGraphqlError } from './expected-error.filter.js';

const host = (type: string) => ({ getType: () => type }) as unknown as ArgumentsHost;

describe('isExpectedGraphqlError', () => {
  it.each([
    [
      'a GraphQLError with a string code',
      new GraphQLError('x', { extensions: { code: 'X' } }),
      true,
    ],
    ['a GraphQLError without a code', new GraphQLError('x'), false],
    [
      'a GraphQLError with a non-string code',
      new GraphQLError('x', { extensions: { code: 1 } }),
      false,
    ],
    [
      'an Error with extensions.code',
      Object.assign(new Error('x'), { extensions: { code: 'X' } }),
      false,
    ],
    ['a formatted error', { message: 'x', extensions: { code: 'X' } }, false],
  ])('%s → %s', (_case, error, expected) => {
    expect(isExpectedGraphqlError(error)).toBe(expected);
  });
});

describe('ExpectedGraphqlErrorFilter in Nest’s GraphQL exception handler', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function handle(error: unknown) {
    const nestError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const filter = new ExpectedGraphqlErrorFilter();
    const handler = new ExternalExceptionsHandler();
    handler.setCustomFilters([
      {
        func: (e: unknown, h: ArgumentsHost) => filter.catch(e as GraphQLError, h),
        exceptionMetatypes: [GraphQLError],
      },
    ]);
    let thrown: unknown;
    try {
      // Throws synchronously; the declared return type is a promise.
      void handler.next(error as Error, host('graphql'));
    } catch (e) {
      thrown = e;
    }
    return { thrown, nestError };
  }

  it('rethrows an expected error without Nest’s ERROR log', () => {
    const error = new GraphQLError('Too many requests', {
      extensions: { code: 'TOO_MANY_REQUESTS' },
    });
    const { thrown, nestError } = handle(error);
    expect(thrown).toBe(error);
    expect(nestError).not.toHaveBeenCalled();
  });

  it.each([
    ['a GraphQLError without a code', new GraphQLError('resolver bug')],
    ['a plain Error', new Error('connect ECONNREFUSED')],
  ])('leaves %s to Nest, which logs it at ERROR and rethrows it', (_case, error) => {
    const { thrown, nestError } = handle(error);
    expect(thrown).toBe(error);
    expect(nestError).toHaveBeenCalledWith(error);
  });

  it('hands a GraphQLError on an HTTP route to Nest’s default HTTP handling', () => {
    const base = jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockReturnValue(undefined);
    const error = new GraphQLError('x', { extensions: { code: 'X' } });
    new ExpectedGraphqlErrorFilter().catch(error, host('http'));
    expect(base).toHaveBeenCalledWith(error, expect.anything());
  });
});
