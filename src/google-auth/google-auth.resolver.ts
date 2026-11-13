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
      'Starts linking for the current user (client token): sets the httpOnly google_auth_state cookie that linkGoogleAccount needs, valid 10 minutes and for this user only. Errors: GOOGLE_LOGIN_DISABLED.',
  })
  startGoogleLink(): GoogleAuthStart {
    throw new NotImplementedException('startGoogleLink is not implemented yet');
  }

  @RequirePermission('wallet')
  @Mutation(() => GoogleAccount, {
    description:
      'Links a Google account to the current user (client token; needs the google_auth_state cookie of startGoogleLink), returning the existing link when it is the same account. Errors: GOOGLE_LOGIN_DISABLED, BAD_USER_INPUT (extensions.field), INVALID_GOOGLE_STATE (no, expired or foreign sign-in: start again), INVALID_GOOGLE_CODE, GOOGLE_EMAIL_NOT_VERIFIED, GOOGLE_ACCOUNT_LINKED_TO_ANOTHER_USER, GOOGLE_ACCOUNT_ALREADY_LINKED (the user has another Google account: unlink it first).',
  })
  linkGoogleAccount(@Args('input') _input: GoogleAuthInput): GoogleAccount {
    throw new NotImplementedException('linkGoogleAccount is not implemented yet');
  }

  @RequirePermission('wallet')
  @Mutation(() => Boolean, {
    description:
      "Unlinks the current user's Google account and ends their other sessions, keeping the one of this request's refresh token cookie (client token; true even when nothing was linked or Google login is off).",
  })
  unlinkGoogleAccount(): boolean {
    throw new NotImplementedException('unlinkGoogleAccount is not implemented yet');
  }

  @Public()
  @Mutation(() => GoogleAuthStart, {
    description:
      'Starts a Google login: sets the httpOnly google_auth_state cookie that loginWithGoogle needs, valid 10 minutes. Errors: GOOGLE_LOGIN_DISABLED.',
  })
  startGoogleLogin(): GoogleAuthStart {
    throw new NotImplementedException('startGoogleLogin is not implemented yet');
  }

  @Public()
  @Mutation(() => AuthPayload, {
    description:
      'Logs in with a linked Google account, starting the same session as login (sets the refresh token cookie, JWT_REFRESH_TTL, 30 days by default; needs the google_auth_state cookie of startGoogleLogin). Errors: GOOGLE_LOGIN_DISABLED, BAD_USER_INPUT (extensions.field), INVALID_GOOGLE_STATE, INVALID_GOOGLE_CODE, GOOGLE_EMAIL_NOT_VERIFIED, GOOGLE_ACCOUNT_NOT_LINKED ("No account is linked to this Google account"), ACCOUNT_LOCKED (extensions.lockedUntil).',
  })
  loginWithGoogle(@Args('input') _input: GoogleAuthInput): AuthPayload {
    throw new NotImplementedException('loginWithGoogle is not implemented yet');
  }
}
