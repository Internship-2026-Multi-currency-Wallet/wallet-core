import { GraphQLError } from 'graphql';

export const ThrottleErrorCode = {
  TooManyRequests: 'TOO_MANY_REQUESTS',
} as const;

export type ThrottleErrorCode = (typeof ThrottleErrorCode)[keyof typeof ThrottleErrorCode];

export function tooManyRequestsError(retryAfterSeconds: number): GraphQLError {
  return new GraphQLError('Too many requests, try again later', {
    extensions: { retryAfterSeconds, code: ThrottleErrorCode.TooManyRequests },
  });
}
