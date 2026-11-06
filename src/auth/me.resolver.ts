import { Query, Resolver } from '@nestjs/graphql';
import type { AuthUser } from './auth-user.js';
import { CurrentUser } from './current-user.decorator.js';
import { Me } from './me.model.js';
import { UserKind, isStaffPermission } from './user-kind.js';

@Resolver(() => Me)
export class MeResolver {
  @Query(() => Me, {
    description: 'The current user (a client or a staff member). Requires authentication.',
  })
  me(@CurrentUser() user: AuthUser): Me {
    return {
      id: user.id,
      // Contract fake until the token carries aud: then AuthUser.kind takes its place.
      kind: user.permissions.some(isStaffPermission) ? UserKind.STAFF : UserKind.CLIENT,
      permissions: user.permissions,
      strategy: user.strategy,
    };
  }
}
