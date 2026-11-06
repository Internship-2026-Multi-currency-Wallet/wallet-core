import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getRequest } from '../auth/request-context.js';
import { UserKind, isStaffPermission } from '../auth/user-kind.js';
import { REQUIRED_PERMISSIONS_KEY } from './require-permission.decorator.js';

/** Global guard (runs after `AuthGuard`): enforces `@RequirePermission(...)`. */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const user = getRequest(context).user;
    if (!user) throw new UnauthorizedException('Authentication required');

    const missing = required.filter((permission) => !user.permissions.includes(permission));
    if (missing.length > 0) {
      throw new ForbiddenException(`Missing permission: ${missing.join(', ')}`);
    }
    // Second lock: a client never reaches a staff endpoint, even with a staff permission by mistake.
    if (required.some(isStaffPermission) && user.kind !== UserKind.STAFF) {
      throw new ForbiddenException('Staff only');
    }
    return true;
  }
}
