import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class RegisterInput {
  @Field({
    description: 'Must be a valid email address. Case-insensitive, must not be registered yet.',
  })
  email: string;

  @Field({
    description:
      'At least 8 characters, with at least one digit, one uppercase letter and one special character (not a letter or digit).',
  })
  password: string;

  @Field(() => String, {
    nullable: true,
    description: 'Optional phone number in international format, e.g. "+380501234567".',
  })
  phone?: string | null;
}
