import { UnauthorizedException } from '@nestjs/common';
import { DevAuthStrategy, parseDevCredentials } from './dev-auth.strategy.js';

describe('DevAuthStrategy', () => {
  const strategy = new DevAuthStrategy();
  const authenticate = (authorization?: string) =>
    strategy.authenticate({ authorization, headers: {} });

  it('parses "Dev <userId>:<permissions>"', () => {
    expect(authenticate('Dev 1:wallet')).toEqual({
      id: '1',
      permissions: ['wallet'],
      strategy: 'dev',
    });
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
