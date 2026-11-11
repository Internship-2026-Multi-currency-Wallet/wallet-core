import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import { httpResponseOf } from '../auth/auth.resolver.js';
import { Public } from '../auth/public.decorator.js';
import {
  STAFF_REFRESH_TOKEN_COOKIE,
  clearRefreshTokenCookie,
  readRefreshToken,
  setRefreshTokenCookie,
} from '../auth/refresh-token-cookie.js';
import { AppConfig } from '../config/app-config.js';
import type { GraphqlContext } from '../graphql/graphql.config.js';
import { AcceptStaffInvitationInput, StaffLoginInput } from './staff.inputs.js';
import { StaffAuthPayload } from './staff.model.js';
import { StaffService } from './staff.service.js';

/**
 * Staff authentication stays isolated from user authentication: the staff refresh token travels only
 * in its own httpOnly cookie, never in arguments or results.
 */
@Resolver()
export class StaffAuthResolver {
  constructor(
    private readonly staff: StaffService,
    private readonly config: AppConfig,
  ) {}

  @Public()
  @Mutation(() => StaffAuthPayload, {
    description:
      'Logs a staff member in (sets the staff refresh token cookie). The session lasts 8 hours from login. Errors: INVALID_CREDENTIALS (also for invited and deactivated accounts), ACCOUNT_LOCKED (extensions.lockedUntil; after 5 failed attempts in a row, for 15 minutes).',
  })
  async staffLogin(
    @Args('input') input: StaffLoginInput,
    @Context() context: GraphqlContext,
  ): Promise<StaffAuthPayload> {
    const res = httpResponseOf(context);
    const result = await this.staff.login(
      input,
      readRefreshToken(context.req, STAFF_REFRESH_TOKEN_COOKIE),
    );
    setRefreshTokenCookie(
      res,
      result.refreshToken,
      result.sessionExpiresAt,
      this.config.isProduction,
      STAFF_REFRESH_TOKEN_COOKIE,
    );
    return result.payload;
  }

  @Public()
  @Mutation(() => StaffAuthPayload, {
    description:
      'Issues a new access token using the staff refresh token cookie, with the current role. Does not extend the 8-hour session. Errors: INVALID_REFRESH_TOKEN (also after deactivation or a role change).',
  })
  async staffRefreshSession(@Context() context: GraphqlContext): Promise<StaffAuthPayload> {
    const res = httpResponseOf(context);
    // A failed refresh leaves the cookie alone: a parallel refresh may have just set a new one.
    const result = await this.staff.refresh(
      readRefreshToken(context.req, STAFF_REFRESH_TOKEN_COOKIE),
    );
    setRefreshTokenCookie(
      res,
      result.refreshToken,
      result.sessionExpiresAt,
      this.config.isProduction,
      STAFF_REFRESH_TOKEN_COOKIE,
    );
    return result.payload;
  }

  @Public()
  @Mutation(() => Boolean, {
    description:
      'Ends the session of the staff refresh token cookie and clears the cookie. Returns true even when there was no session.',
  })
  async staffLogout(@Context() context: GraphqlContext): Promise<boolean> {
    const res = httpResponseOf(context);
    await this.staff.logout(readRefreshToken(context.req, STAFF_REFRESH_TOKEN_COOKIE));
    clearRefreshTokenCookie(res, this.config.isProduction, STAFF_REFRESH_TOKEN_COOKIE);
    return true;
  }

  @Public()
  @Mutation(() => Boolean, {
    description:
      'Sets the password of an invited staff member and activates the account. The token works once and expires 48 hours after it was sent. Does not log in: call staffLogin afterwards. Errors: INVALID_INVITATION (unknown, used, expired or replaced token), BAD_USER_INPUT (extensions.field).',
  })
  async acceptStaffInvitation(@Args('input') input: AcceptStaffInvitationInput): Promise<boolean> {
    await this.staff.acceptInvitation(input);
    return true;
  }
}
