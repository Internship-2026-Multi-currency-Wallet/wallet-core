import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from './auth-user.js';
import { Authenticator } from './authenticator.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { getRequest } from './request-context.js';

/** Without a user the request is rejected with 401, unless the handler is `@Public()`. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticator: Authenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = getRequest(context);

    let user: AuthUser | null;
    try {
      user = await this.authenticator.authenticate(request);
    } catch (error) {
      if (isPublic) return true; // bad credentials on a public endpoint: treat as anonymous
      throw error;
    }

    if (user) {
      request.user = user;
      return true;
    }
    if (isPublic) return true;
    throw new UnauthorizedException('Authentication required');
  }
}
