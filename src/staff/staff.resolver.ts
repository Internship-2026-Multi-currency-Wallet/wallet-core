import { NotImplementedException } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { RequirePermission } from '../permissions/require-permission.decorator.js';
import { StaffRole } from './permissions.js';
import { ChangeOwnStaffPasswordInput, InviteStaffInput } from './staff.inputs.js';
import { StaffMe, StaffMember } from './staff.model.js';

/**
 * Staff management and the staff member's own account. Contract only: every operation throws until
 * it is implemented. Permissions are listed in `permissions.ts`.
 */
@Resolver()
export class StaffResolver {
  @RequirePermission('bo:staff')
  @Query(() => [StaffMember], {
    description: 'All staff accounts of this client. Requires bo:staff. Errors: FORBIDDEN.',
  })
  staffMembers(): StaffMember[] {
    throw new NotImplementedException('staffMembers is not implemented yet');
  }

  @RequirePermission('bo:staff:modify')
  @Mutation(() => StaffMember, {
    description:
      'Creates an INVITED staff member and emails a one-time invitation link (valid 48 hours). Requires bo:staff:modify. Errors: FORBIDDEN, BAD_USER_INPUT (extensions.field), STAFF_ALREADY_EXISTS.',
  })
  inviteStaff(@Args('input') _input: InviteStaffInput): StaffMember {
    throw new NotImplementedException('inviteStaff is not implemented yet');
  }

  @RequirePermission('bo:staff:modify')
  @Mutation(() => StaffMember, {
    description:
      'Emails a new invitation link to an INVITED staff member; earlier links stop working. Requires bo:staff:modify. Errors: FORBIDDEN, STAFF_NOT_FOUND, NOT_INVITED.',
  })
  resendStaffInvitation(@Args('staffId', { type: () => ID }) _staffId: string): StaffMember {
    throw new NotImplementedException('resendStaffInvitation is not implemented yet');
  }

  @RequirePermission('bo:staff:modify')
  @Mutation(() => StaffMember, {
    description:
      'Deactivates a staff member and ends their sessions (an access token already issued stays valid up to 15 minutes). Requires bo:staff:modify. Errors: FORBIDDEN, STAFF_NOT_FOUND, CANNOT_DEACTIVATE_SELF, LAST_ADMIN.',
  })
  deactivateStaff(@Args('staffId', { type: () => ID }) _staffId: string): StaffMember {
    throw new NotImplementedException('deactivateStaff is not implemented yet');
  }

  @RequirePermission('bo:staff:modify')
  @Mutation(() => StaffMember, {
    description:
      "Changes the role and ends the staff member's sessions, so they log in again with the new permissions (an access token already issued stays valid up to 15 minutes). Requires bo:staff:modify. Errors: FORBIDDEN, STAFF_NOT_FOUND, LAST_ADMIN.",
  })
  changeStaffRole(
    @Args('staffId', { type: () => ID }) _staffId: string,
    @Args('role', { type: () => StaffRole }) _role: StaffRole,
  ): StaffMember {
    throw new NotImplementedException('changeStaffRole is not implemented yet');
  }

  @RequirePermission('bo')
  @Query(() => StaffMe, {
    description:
      'The logged-in staff member with the permissions of their role. Requires a staff login (bo). Errors: UNAUTHENTICATED, FORBIDDEN (e.g. a user token), STAFF_NOT_FOUND.',
  })
  staffMe(): StaffMe {
    throw new NotImplementedException('staffMe is not implemented yet');
  }

  @RequirePermission('bo')
  @Mutation(() => Boolean, {
    description:
      'Changes the own password after checking the current one. Ends all other sessions of this staff member (this one stays) and emails a "password changed" notice. Requires bo. Errors: UNAUTHENTICATED, FORBIDDEN, INVALID_CURRENT_PASSWORD, BAD_USER_INPUT (extensions.field).',
  })
  changeOwnStaffPassword(@Args('input') _input: ChangeOwnStaffPasswordInput): boolean {
    throw new NotImplementedException('changeOwnStaffPassword is not implemented yet');
  }
}
