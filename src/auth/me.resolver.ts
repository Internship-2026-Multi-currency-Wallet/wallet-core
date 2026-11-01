import { Query, Resolver } from '@nestjs/graphql';
import type { AuthUser } from './auth-user.js';
import { CurrentUser } from './current-user.decorator.js';
import { Me } from './me.model.js';

@Resolver(() => Me)
export class MeResolver {
  @Query(() => Me, { description: 'The current user. Requires authentication.' })
  me(@CurrentUser() user: AuthUser): Me {
    return { id: user.id, permissions: user.permissions, strategy: user.strategy };
  }
}
