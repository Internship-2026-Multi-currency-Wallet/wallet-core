import { NotImplementedException } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { RequirePermission } from '../permissions/require-permission.decorator.js';
import { StaffRole } from './permissions.js';
import { ChangeOwnStaffPasswordInput, InviteStaffInput } from './staff.inputs.js';
import { StaffMe, StaffMember } from './staff.model.js';
import { StaffService } from './staff.service.js';

@Resolver()
export class StaffResolver {
  constructor(private readonly staff: StaffService) {}

  @RequirePermission('bo:staff')
  @Query(() => [StaffMember], {
    description: 'All staff accounts of this client. Requires bo:staff. Errors: FORBIDDEN.',
  })
  staffMembers(): Promise<StaffMember[]> {
    return this.staff.list();
  }

  @RequirePermission('bo:staff:modify')
  @Mutation(() => StaffMember, {
    description:
      'Creates an INVITED staff member and emails a one-time invitation link (valid 48 hours). Requires bo:staff:modify. Errors: FORBIDDEN, BAD_USER_INPUT (extensions.field), STAFF_ALREADY_EXISTS.',
  })
  inviteStaff(
    @CurrentUser() user: AuthUser,
    @Args('input') input: InviteStaffInput,
  ): Promise<StaffMember> {
    return this.staff.invite(user.id, input);
  }

  @RequirePermission('bo:staff:modify')
  @Mutation(() => StaffMember, {
    description:
      'Emails a new invitation link to an INVITED staff member; earlier links stop working. Requires bo:staff:modify. Errors: FORBIDDEN, STAFF_NOT_FOUND, NOT_INVITED.',
  })
  resendStaffInvitation(
    @CurrentUser() user: AuthUser,
    @Args('staffId', { type: () => ID }) staffId: string,
  ): Promise<StaffMember> {
    return this.staff.resendInvitation(user.id, staffId);
  }

  @RequirePermission('bo:staff:modify')
  @Mutation(() => StaffMember, {
    description:
      'Deactivates a staff member and ends their sessions (an access token already issued stays valid up to 15 minutes). Requires bo:staff:modify. Errors: FORBIDDEN, STAFF_NOT_FOUND, CANNOT_DEACTIVATE_SELF, LAST_ADMIN.',
  })
  deactivateStaff(
    @CurrentUser() user: AuthUser,
    @Args('staffId', { type: () => ID }) staffId: string,
  ): Promise<StaffMember> {
    return this.staff.deactivate(user.id, staffId);
  }

  @RequirePermission('bo:staff:modify')
  @Mutation(() => StaffMember, {
    description:
      "Changes the role and ends the staff member's sessions, so they log in again with the new permissions (an access token already issued stays valid up to 15 minutes). Requires bo:staff:modify. Errors: FORBIDDEN, STAFF_NOT_FOUND, LAST_ADMIN.",
  })
  changeStaffRole(
    @CurrentUser() user: AuthUser,
    @Args('staffId', { type: () => ID }) staffId: string,
    @Args('role', { type: () => StaffRole }) role: StaffRole,
  ): Promise<StaffMember> {
    return this.staff.changeRole(user.id, staffId, role);
  }

  @RequirePermission('bo')
  @Query(() => StaffMe, {
    description:
      'The logged-in staff member with the permissions of their role. Requires a staff login (bo). Errors: UNAUTHENTICATED, FORBIDDEN (e.g. a user token), STAFF_NOT_FOUND.',
  })
  staffMe(@CurrentUser() user: AuthUser): Promise<StaffMe> {
    return this.staff.me(user.id);
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
