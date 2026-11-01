import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:isPublic';

/**
 * Marks a resolver/controller (or a single handler) as reachable without authentication.
 * `@CurrentUser()` is still filled in when the caller sends valid credentials.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
