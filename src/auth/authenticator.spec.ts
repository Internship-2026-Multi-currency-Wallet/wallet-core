import { jest } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';
import type { AuthStrategy } from './auth-strategy.js';
import type { AuthUser } from './auth-user.js';
import { Authenticator } from './authenticator.js';
import { UserKind } from './user-kind.js';

const USER: AuthUser = { id: '1', kind: UserKind.CLIENT, permissions: [], strategy: 'a' };

function strategy(result: AuthUser | null | Error) {
  const authenticate = jest.fn<AuthStrategy['authenticate']>(() => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { name: 'a', authenticate };
}

describe('Authenticator', () => {
  it('uses the first strategy that returns a user, passing the Authorization header', async () => {
    const skipped = strategy(null);
    const winner = strategy(USER);
    const unused = strategy(null);
    const headers = { authorization: 'Bearer x' };

    const user = await new Authenticator([skipped, winner, unused]).authenticate({ headers });

    expect(user).toBe(USER);
    expect(winner.authenticate).toHaveBeenCalledWith({ authorization: 'Bearer x', headers });
    expect(unused.authenticate).not.toHaveBeenCalled();
  });

  it('returns null when no strategy knows the credentials', async () => {
    await expect(new Authenticator([strategy(null)]).authenticate({ headers: {} })).resolves.toBe(
      null,
    );
  });

  it('runs the strategies once per request object, for a user and for a rejection', async () => {
    const ok = strategy(USER);
    const bad = strategy(new UnauthorizedException('expired'));
    const request = { headers: {} };
    const authenticator = new Authenticator([ok]);
    await Promise.all([authenticator.authenticate(request), authenticator.authenticate(request)]);
    expect(ok.authenticate).toHaveBeenCalledTimes(1);

    const failing = new Authenticator([bad]);
    const other = { headers: {} };
    await expect(failing.authenticate(other)).rejects.toThrow('expired');
    await expect(failing.authenticate(other)).rejects.toThrow('expired');
    expect(bad.authenticate).toHaveBeenCalledTimes(1);

    await authenticator.authenticate({ headers: {} });
    expect(ok.authenticate).toHaveBeenCalledTimes(2);
  });
});
