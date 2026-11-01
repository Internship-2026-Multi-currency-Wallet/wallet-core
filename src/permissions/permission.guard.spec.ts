import { type ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RequestLike } from '../auth/request-context.js';
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
  user: { id: '1', permissions, strategy: 'dev' },
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

  it('returns 401 when there is no user at all', () => {
    expect(() => guard.canActivate(context(UsersController, 'list', { headers: {} }))).toThrow(
      UnauthorizedException,
    );
  });
});
