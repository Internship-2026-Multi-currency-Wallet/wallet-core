import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { StaffRole } from './permissions.js';

export enum StaffStatus {
  INVITED = 'INVITED',
  ACTIVE = 'ACTIVE',
  DEACTIVATED = 'DEACTIVATED',
}

registerEnumType(StaffRole, {
  name: 'StaffRole',
  description:
    'Back-office role. Each role has a fixed permission list (README, "Staff roles"). ADMIN: everything; FINANCE: settings; SUPPORT, COMPLIANCE: base access for now.',
});

registerEnumType(StaffStatus, {
  name: 'StaffStatus',
  description:
    'INVITED: invitation sent, no password yet. ACTIVE: can log in. DEACTIVATED: cannot log in.',
});

@ObjectType({ description: 'A staff account of this client, as shown in staff management.' })
export class StaffMember {
  @Field(() => ID, { description: 'Staff id (UUID).' })
  id: string;

  @Field()
  email: string;

  @Field(() => StaffRole)
  role: StaffRole;

  @Field(() => StaffStatus)
  status: StaffStatus;

  @Field({ description: 'When the staff member was invited.' })
  createdAt: Date;
}

@ObjectType({ description: 'The logged-in staff member.' })
export class StaffMe {
  @Field(() => ID, { description: 'Staff id (UUID).' })
  id: string;

  @Field()
  email: string;

  @Field(() => StaffRole)
  role: StaffRole;

  @Field(() => [String], {
    description:
      'Permissions of the role, e.g. "bo:settings:modify". Show pages and buttons by these.',
  })
  permissions: string[];
}

@ObjectType({
  description:
    'Result of staffLogin and staffRefreshSession. The refresh token is not here: it is set as an httpOnly cookie (separate from the user cookie).',
})
export class StaffAuthPayload {
  @Field({ description: 'Short-lived JWT. Send it as "Authorization: Bearer <token>".' })
  accessToken: string;

  @Field({ description: 'When the access token expires. Call staffRefreshSession before that.' })
  accessTokenExpiresAt: Date;

  @Field(() => StaffMe)
  staff: StaffMe;
}
