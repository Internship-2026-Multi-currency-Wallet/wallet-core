import { UnauthorizedException } from '@nestjs/common';
import { DevAuthStrategy, parseDevCredentials } from './dev-auth.strategy.js';
import { UserKind } from './user-kind.js';

describe('DevAuthStrategy', () => {
  const strategy = new DevAuthStrategy();
  const authenticate = (authorization?: string) =>
    strategy.authenticate({ authorization, headers: {} });

  it('parses "Dev <userId>:<permissions>"', () => {
    expect(authenticate('Dev 1:wallet')).toEqual({
      id: '1',
      kind: UserKind.CLIENT,
      permissions: ['wallet'],
      strategy: 'dev',
    });
  });

  // Until E1-13 puts the user type into the header.
  it.each([
    ['Dev 1:wallet', UserKind.CLIENT],
    ['Dev 7', UserKind.CLIENT],
    ['Dev 7:boss', UserKind.CLIENT],
    ['Dev 42:bo', UserKind.STAFF],
    ['Dev 100:bo:users,bo:users:modify', UserKind.STAFF],
    ['Dev 1:wallet,bo', UserKind.STAFF],
  ])('makes %s a %s: staff permissions mean staff', (authorization, kind) => {
    expect(authenticate(authorization)?.kind).toBe(kind);
  });

  it('keeps colons inside permission names', () => {
    expect(authenticate('Dev 42:bo:users,bo:users:modify')?.permissions).toEqual([
      'bo:users',
      'bo:users:modify',
    ]);
  });

  it('accepts a user without permissions, trims and de-duplicates', () => {
    expect(authenticate('Dev 7')?.permissions).toEqual([]);
    expect(authenticate('dev  7: a , b,a ,')?.permissions).toEqual(['a', 'b']);
  });

  it('ignores other schemes and missing headers', () => {
    expect(authenticate(undefined)).toBeNull();
    expect(authenticate('Bearer abc.def.ghi')).toBeNull();
  });

  it('rejects malformed dev credentials', () => {
    expect(() => parseDevCredentials(':wallet')).toThrow(UnauthorizedException);
    expect(() => parseDevCredentials('a b:wallet')).toThrow(UnauthorizedException);
  });
});
