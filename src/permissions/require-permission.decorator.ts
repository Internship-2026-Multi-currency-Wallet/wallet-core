import { SetMetadata } from '@nestjs/common';

export const REQUIRED_PERMISSIONS_KEY = 'auth:requiredPermissions';

/**
 * Requires the current user to have **all** listed permissions, otherwise 403.
 *
 *   @RequirePermission('bo:users:modify')
 *   @Mutation(() => User)
 *   blockUser(...) { ... }
 *
 * Can be put on a class (applies to every handler) or on a method (overrides the class).
 */
export const RequirePermission = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);
