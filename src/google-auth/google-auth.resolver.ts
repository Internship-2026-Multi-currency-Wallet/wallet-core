import { NotImplementedException } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthPayload } from '../auth/auth-payload.model.js';
import { Public } from '../auth/public.decorator.js';
import { RequirePermission } from '../permissions/require-permission.decorator.js';
import { GoogleAccount, GoogleAuthStart } from './google-account.model.js';
import { GoogleAuthInput } from './google-auth.inputs.js';

@Resolver()
export class GoogleAuthResolver {
  @RequirePermission('wallet')
  @Query(() => GoogleAccount, {
    nullable: true,
    description: 'The Google account linked to the current user, or null. Client token only.',
  })
  googleAccount(): GoogleAccount | null {
    throw new NotImplementedException('googleAccount is not implemented yet');
  }

  @RequirePermission('wallet')
  @Mutation(() => GoogleAuthStart, {
    description:
      'Starts linking a Google account to the current user. Client token only. Sets the httpOnly google_auth_state cookie that linkGoogleAccount checks; valid for 10 minutes, for this user only. Errors: GOOGLE_LOGIN_DISABLED.',
  })
  startGoogleLink(): GoogleAuthStart {
    throw new NotImplementedException('startGoogleLink is not implemented yet');
  }

  @RequirePermission('wallet')
  @Mutation(() => GoogleAccount, {
    description:
      'Links a Google account to the current user. Client token only; needs the google_auth_state cookie of startGoogleLink. Linking the same Google account again returns it. Errors: GOOGLE_LOGIN_DISABLED, BAD_USER_INPUT (extensions.field), INVALID_GOOGLE_STATE (no, expired or foreign sign-in: start again), INVALID_GOOGLE_CODE, GOOGLE_EMAIL_NOT_VERIFIED, GOOGLE_ACCOUNT_LINKED_TO_ANOTHER_USER, GOOGLE_ACCOUNT_ALREADY_LINKED (the user has another Google account: unlink it first).',
  })
  linkGoogleAccount(@Args('input') _input: GoogleAuthInput): GoogleAccount {
    throw new NotImplementedException('linkGoogleAccount is not implemented yet');
  }

  @RequirePermission('wallet')
  @Mutation(() => Boolean, {
    description:
      "Unlinks the Google account of the current user and ends the user's other sessions (the session of the refresh token cookie sent with this request stays). Client token only. Works even when Google login is disabled. Returns true even when nothing was linked.",
  })
  unlinkGoogleAccount(): boolean {
    throw new NotImplementedException('unlinkGoogleAccount is not implemented yet');
  }

  @Public()
  @Mutation(() => GoogleAuthStart, {
    description:
      'Starts logging in with Google. Sets the httpOnly google_auth_state cookie that loginWithGoogle checks; valid for 10 minutes. Errors: GOOGLE_LOGIN_DISABLED.',
  })
  startGoogleLogin(): GoogleAuthStart {
    throw new NotImplementedException('startGoogleLogin is not implemented yet');
  }

  @Public()
  @Mutation(() => AuthPayload, {
    description:
      'Logs in with a linked Google account (sets the refresh token cookie), the same session as login (JWT_REFRESH_TTL, 30 days by default). Needs the google_auth_state cookie of startGoogleLogin. Errors: GOOGLE_LOGIN_DISABLED, BAD_USER_INPUT (extensions.field), INVALID_GOOGLE_STATE, INVALID_GOOGLE_CODE, GOOGLE_EMAIL_NOT_VERIFIED, GOOGLE_ACCOUNT_NOT_LINKED ("No account is linked to this Google account"), ACCOUNT_LOCKED (extensions.lockedUntil).',
  })
  loginWithGoogle(@Args('input') _input: GoogleAuthInput): AuthPayload {
    throw new NotImplementedException('loginWithGoogle is not implemented yet');
  }
}
