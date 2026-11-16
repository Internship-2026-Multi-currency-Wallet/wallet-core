import { type ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RequestLike } from '../auth/request-context.js';
import { UserKind } from '../auth/user-kind.js';
import { PermissionGuard } from './permission.guard.js';
import { RequirePermission } from './require-permission.decorator.js';

@RequirePermission('bo:users')
class UsersController {
  list(): void {}

  @RequirePermission('bo:users', 'bo:users:modify')
  block(): void {}
}

class OpenController {
  anything(): void {}
}

class WalletController {
  @RequirePermission('wallet')
  balance(): void {}

  @RequirePermission('wallet:transfers')
  transfer(): void {}

  @RequirePermission('wallets')
  wallets(): void {}

  @RequirePermission('bonus')
  bonus(): void {}
}

function context(cls: new () => object, handler: string, request: RequestLike): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => (cls.prototype as Record<string, unknown>)[handler],
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const user = (...permissions: string[]): RequestLike => ({
  headers: {},
  user: { id: '1', kind: UserKind.STAFF, permissions, strategy: 'dev' },
});

const client = (...permissions: string[]): RequestLike => ({
  headers: {},
  user: { id: '1', kind: UserKind.CLIENT, permissions, strategy: 'jwt' },
});

describe('PermissionGuard', () => {
  const guard = new PermissionGuard(new Reflector());

  it('allows handlers without @RequirePermission', () => {
    expect(guard.canActivate(context(OpenController, 'anything', { headers: {} }))).toBe(true);
  });

  it('applies a class-level requirement', () => {
    expect(guard.canActivate(context(UsersController, 'list', user('bo:users')))).toBe(true);
    expect(() => guard.canActivate(context(UsersController, 'list', user('wallet')))).toThrow(
      ForbiddenException,
    );
  });

  it('requires all permissions of a method-level requirement', () => {
    expect(() => guard.canActivate(context(UsersController, 'block', user('bo:users')))).toThrow(
      'Missing permission: bo:users:modify',
    );
    expect(
      guard.canActivate(context(UsersController, 'block', user('bo:users', 'bo:users:modify'))),
    ).toBe(true);
  });

  describe('staff endpoints', () => {
    it('refuses a client that somehow has the staff permission', () => {
      expect(() => guard.canActivate(context(UsersController, 'list', client('bo:users')))).toThrow(
        'Staff only',
      );
    });

    it('still names the missing permission when the client does not have it', () => {
      expect(() => guard.canActivate(context(UsersController, 'list', client('wallet')))).toThrow(
        'Missing permission: bo:users',
      );
    });

    it('lets a client through a client endpoint', () => {
      expect(guard.canActivate(context(WalletController, 'balance', client('wallet')))).toBe(true);
    });

    it('does not take a permission that only starts with "bo" as a staff one', () => {
      expect(guard.canActivate(context(WalletController, 'bonus', client('bonus')))).toBe(true);
    });
  });

  describe('client endpoints', () => {
    it('refuses a staff token that somehow has the wallet permission', () => {
      expect(() => guard.canActivate(context(WalletController, 'balance', user('wallet')))).toThrow(
        'Clients only',
      );
    });

    it('takes wallet:… as a client permission', () => {
      expect(() =>
        guard.canActivate(context(WalletController, 'transfer', user('wallet:transfers'))),
      ).toThrow('Clients only');
    });

    it('does not take a permission that only starts with "wallet" as a client one', () => {
      expect(guard.canActivate(context(WalletController, 'wallets', user('wallets')))).toBe(true);
    });

    it('still names the missing permission when the staff token does not have it', () => {
      expect(() =>
        guard.canActivate(context(WalletController, 'balance', user('bo:users'))),
      ).toThrow('Missing permission: wallet');
    });
  });

  it('returns 401 when there is no user at all', () => {
    expect(() => guard.canActivate(context(UsersController, 'list', { headers: {} }))).toThrow(
      UnauthorizedException,
    );
  });
});
