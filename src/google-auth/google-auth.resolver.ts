import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { Response } from 'express';
import { AuthPayload } from '../auth/auth-payload.model.js';
import type { AuthUser } from '../auth/auth-user.js';
import { httpResponseOf } from '../auth/auth.resolver.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Public } from '../auth/public.decorator.js';
import {
  clearRefreshTokenCookie,
  readRefreshToken,
  setRefreshTokenCookie,
} from '../auth/refresh-token-cookie.js';
import { AppConfig } from '../config/app-config.js';
import type { GraphqlContext } from '../graphql/graphql.config.js';
import { RequirePermission } from '../permissions/require-permission.decorator.js';
import { GoogleAccount, GoogleAuthStart } from './google-account.model.js';
import { GOOGLE_AUTH_STATE_COOKIE, type GoogleAuthStateIssued } from './google-auth-state.js';
import { GoogleAuthInput } from './google-auth.inputs.js';
import { type GoogleAuthCookies, GoogleAuthService } from './google-auth.service.js';

@Resolver()
export class GoogleAuthResolver {
  constructor(
    private readonly google: GoogleAuthService,
    private readonly config: AppConfig,
  ) {}

  @RequirePermission('wallet')
  @Query(() => GoogleAccount, {
    nullable: true,
    description: 'Requires a client token.',
  })
  googleAccount(@CurrentUser() user: AuthUser): Promise<GoogleAccount | null> {
    return this.google.get(user.id);
  }

  @RequirePermission('wallet')
  @Mutation(() => GoogleAuthStart, {
    description:
      'Starts linking for the current user (client token): sets the httpOnly google_auth_state cookie that linkGoogleAccount needs, valid 10 minutes and for this user only. Errors: GOOGLE_LOGIN_DISABLED.',
  })
  async startGoogleLink(
    @CurrentUser() user: AuthUser,
    @Context() context: GraphqlContext,
  ): Promise<GoogleAuthStart> {
    const res = httpResponseOf(context);
    return this.withStateCookie(res, await this.google.start(user.id));
  }

  @RequirePermission('wallet')
  @Mutation(() => GoogleAccount, {
    description:
      'Links a Google account to the current user (client token; needs the google_auth_state cookie of startGoogleLink), returning the existing link when it is the same account. Errors: GOOGLE_LOGIN_DISABLED, BAD_USER_INPUT (extensions.field), INVALID_GOOGLE_STATE (no, expired or foreign sign-in: start again), INVALID_GOOGLE_CODE, GOOGLE_EMAIL_NOT_VERIFIED, GOOGLE_ACCOUNT_LINKED_TO_ANOTHER_USER, GOOGLE_ACCOUNT_ALREADY_LINKED (the user has another Google account: unlink it first).',
  })
  async linkGoogleAccount(
    @CurrentUser() user: AuthUser,
    @Args('input') input: GoogleAuthInput,
    @Context() context: GraphqlContext,
  ): Promise<GoogleAccount> {
    const res = httpResponseOf(context);
    try {
      return await this.google.link(user.id, input, this.cookiesOf(context));
    } finally {
      this.clearStateCookie(res);
    }
  }

  @RequirePermission('wallet')
  @Mutation(() => Boolean, {
    description:
      "Unlinks the current user's Google account and ends their other sessions, keeping the one of this request's refresh token cookie (client token; true even when nothing was linked or Google login is off).",
  })
  unlinkGoogleAccount(
    @CurrentUser() user: AuthUser,
    @Context() context: GraphqlContext,
  ): Promise<boolean> {
    return this.google.unlink(user.id, readRefreshToken(context.req));
  }

  @Public()
  @Mutation(() => GoogleAuthStart, {
    description:
      'Starts a Google login: sets the httpOnly google_auth_state cookie that loginWithGoogle needs, valid 10 minutes. Errors: GOOGLE_LOGIN_DISABLED.',
  })
  async startGoogleLogin(@Context() context: GraphqlContext): Promise<GoogleAuthStart> {
    const res = httpResponseOf(context);
    return this.withStateCookie(res, await this.google.start(null));
  }

  @Public()
  @Mutation(() => AuthPayload, {
    description:
      'Logs in with a linked Google account, starting the same session as login (sets the refresh token cookie, JWT_REFRESH_TTL, 30 days by default; needs the google_auth_state cookie of startGoogleLogin). Errors: GOOGLE_LOGIN_DISABLED, BAD_USER_INPUT (extensions.field), INVALID_GOOGLE_STATE, INVALID_GOOGLE_CODE, GOOGLE_EMAIL_NOT_VERIFIED, GOOGLE_ACCOUNT_NOT_LINKED ("No account is linked to this Google account"), ACCOUNT_LOCKED (extensions.lockedUntil).',
  })
  async loginWithGoogle(
    @Args('input') input: GoogleAuthInput,
    @Context() context: GraphqlContext,
  ): Promise<AuthPayload> {
    const res = httpResponseOf(context);
    try {
      const result = await this.google.login(input, this.cookiesOf(context));
      setRefreshTokenCookie(
        res,
        result.refreshToken,
        result.sessionExpiresAt,
        this.config.isProduction,
      );
      return result.payload;
    } finally {
      this.clearStateCookie(res);
    }
  }

  private cookiesOf(context: GraphqlContext): GoogleAuthCookies {
    return {
      state: readRefreshToken(context.req, GOOGLE_AUTH_STATE_COOKIE),
      refreshToken: readRefreshToken(context.req),
    };
  }

  private withStateCookie(res: Response, issued: GoogleAuthStateIssued): GoogleAuthStart {
    setRefreshTokenCookie(
      res,
      issued.cookie,
      issued.expiresAt,
      this.config.isProduction,
      GOOGLE_AUTH_STATE_COOKIE,
    );
    return { state: issued.state, nonce: issued.nonce, expiresAt: issued.expiresAt };
  }

  private clearStateCookie(res: Response): void {
    clearRefreshTokenCookie(res, this.config.isProduction, GOOGLE_AUTH_STATE_COOKIE);
  }
}
