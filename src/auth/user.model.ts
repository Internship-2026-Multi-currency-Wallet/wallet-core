import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'A registered wallet user.' })
export class User {
  @Field(() => ID, { description: 'User id (UUID).' })
  id: string;

  @Field()
  email: string;

  @Field(() => String, { nullable: true, description: 'Phone number, if the user gave one.' })
  phone: string | null;
}
