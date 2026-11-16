import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class GoogleAccount {
  @Field({ description: 'Verified by Google, as reported when the account was linked.' })
  email: string;

  @Field()
  linkedAt: Date;
}

@ObjectType({
  description:
    'Put `state` and `nonce` into the Google authorization URL; the matching cookie is set with this answer.',
})
export class GoogleAuthStart {
  @Field()
  state: string;

  @Field()
  nonce: string;

  @Field()
  expiresAt: Date;
}
