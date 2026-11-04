import { Field, InputType } from '@nestjs/graphql';
import { StaffRole } from './permissions.js';

@InputType()
export class InviteStaffInput {
  @Field({
    description: 'Valid email address. Case-insensitive, must not belong to another staff member.',
  })
  email: string;

  @Field(() => StaffRole)
  role: StaffRole;
}

@InputType()
export class AcceptStaffInvitationInput {
  @Field({ description: 'The token from the invitation link (/accept-invitation?token=…).' })
  token: string;

  @Field({
    description:
      'New password: 8 to 128 characters, with at least one digit, one uppercase letter and one special character (same rules as user registration).',
  })
  password: string;
}

@InputType()
export class StaffLoginInput {
  @Field()
  email: string;

  @Field()
  password: string;
}

@InputType()
export class ChangeOwnStaffPasswordInput {
  @Field()
  currentPassword: string;

  @Field({ description: 'Same rules as AcceptStaffInvitationInput.password.' })
  newPassword: string;
}
