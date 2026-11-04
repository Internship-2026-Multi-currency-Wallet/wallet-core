import { NotImplementedException } from '@nestjs/common';
import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { Public } from '../auth/public.decorator.js';
import { AcceptStaffInvitationInput, StaffLoginInput } from './staff.inputs.js';
import { StaffAuthPayload } from './staff.model.js';

/**
 * Back-office login, separate from user login: a staff token is never accepted as a user token and
 * vice versa. Contract only: every mutation throws until it is implemented.
 * The staff refresh token travels in its own httpOnly cookie, never in arguments or results.
 */
@Resolver()
export class StaffAuthResolver {
  @Public()
  @Mutation(() => StaffAuthPayload, {
    description:
      'Logs a staff member in (sets the staff refresh token cookie). The session lasts 8 hours from login. Errors: INVALID_CREDENTIALS (also for invited and deactivated accounts), ACCOUNT_LOCKED (extensions.lockedUntil; after 5 failed attempts in a row, for 15 minutes).',
  })
  staffLogin(@Args('input') _input: StaffLoginInput): StaffAuthPayload {
    throw new NotImplementedException('staffLogin is not implemented yet');
  }

  @Public()
  @Mutation(() => StaffAuthPayload, {
    description:
      'Issues a new access token using the staff refresh token cookie, with the current role. Does not extend the 8-hour session. Errors: INVALID_REFRESH_TOKEN (also after deactivation or a role change).',
  })
  staffRefreshSession(): StaffAuthPayload {
    throw new NotImplementedException('staffRefreshSession is not implemented yet');
  }

  @Public()
  @Mutation(() => Boolean, {
    description:
      'Ends the session of the staff refresh token cookie and clears the cookie. Returns true even when there was no session.',
  })
  staffLogout(): boolean {
    throw new NotImplementedException('staffLogout is not implemented yet');
  }

  @Public()
  @Mutation(() => Boolean, {
    description:
      'Sets the password of an invited staff member and activates the account. The token works once and expires 48 hours after it was sent. Does not log in: call staffLogin afterwards. Errors: INVALID_INVITATION (unknown, used, expired or replaced token), BAD_USER_INPUT (extensions.field).',
  })
  acceptStaffInvitation(@Args('input') _input: AcceptStaffInvitationInput): boolean {
    throw new NotImplementedException('acceptStaffInvitation is not implemented yet');
  }
}
