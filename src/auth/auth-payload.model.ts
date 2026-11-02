import { Field, ObjectType } from '@nestjs/graphql';
import { User } from './user.model.js';

@ObjectType({
  description:
    'Result of register, login and refreshSession. The refresh token is not here: it is set as an httpOnly cookie.',
})
export class AuthPayload {
  @Field({ description: 'Short-lived JWT. Send it as "Authorization: Bearer <token>".' })
  accessToken: string;

  @Field({ description: 'When the access token expires. Call refreshSession before that.' })
  accessTokenExpiresAt: Date;

  @Field(() => User)
  user: User;
}
