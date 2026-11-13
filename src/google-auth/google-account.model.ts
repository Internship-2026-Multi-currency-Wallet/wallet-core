import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'The Google account linked to the current user.' })
export class GoogleAccount {
  @Field({
    description: 'Verified email of the Google account, as Google reported it when it was linked.',
  })
  email: string;

  @Field()
  linkedAt: Date;
}

@ObjectType({
  description:
    'Put `state` and `nonce` into the Google authorization URL. The matching httpOnly cookie is set with this answer.',
})
export class GoogleAuthStart {
  @Field({ description: 'The `state` parameter of the Google authorization URL.' })
  state: string;

  @Field({ description: 'The `nonce` parameter of the Google authorization URL.' })
  nonce: string;

  @Field({ description: 'Finish the sign-in before this time, or start again.' })
  expiresAt: Date;
}
