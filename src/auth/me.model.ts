import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'The authenticated caller.' })
export class Me {
  @Field(() => ID)
  id: string;

  @Field(() => [String], { description: 'Permission strings, e.g. "bo:users:modify".' })
  permissions: string[];

  @Field({ description: 'Strategy that authenticated the request, e.g. "dev" or "jwt".' })
  strategy: string;
}
