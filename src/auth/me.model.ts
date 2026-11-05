import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { UserKind } from './user-kind.js';

registerEnumType(UserKind, {
  name: 'UserKind',
  description: 'CLIENT: a wallet user. STAFF: a back-office staff member.',
});

@ObjectType({ description: 'The authenticated caller.' })
export class Me {
  @Field(() => ID)
  id: string;

  @Field(() => UserKind)
  kind: UserKind;

  @Field(() => [String], { description: 'Permission strings, e.g. "bo:users:modify".' })
  permissions: string[];

  @Field({ description: 'Strategy that authenticated the request, e.g. "dev" or "jwt".' })
  strategy: string;
}
