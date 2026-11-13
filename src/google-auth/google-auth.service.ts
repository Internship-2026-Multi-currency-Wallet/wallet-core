import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AUTH_ERROR_MESSAGES, AuthErrorCode, authError } from '../auth/auth-errors.js';
import { AuthService, type LoginResult, accountLocked } from '../auth/auth.service.js';
import { AppConfig } from '../config/app-config.js';
import { ClientSettingsService } from '../settings/client-settings.service.js';
import {
  GoogleAccountsRepository,
  LinkGoogleResult,
  type LinkedGoogleAccount,
} from './google-accounts.repository.js';
import type { GoogleAccount } from './google-account.model.js';
import {
  type GoogleAuthPurpose,
  GoogleAuthStateService,
  type GoogleAuthStateIssued,
  equal,
} from './google-auth-state.js';
import type { GoogleAuthInput } from './google-auth.inputs.js';
import {
  GOOGLE_IDENTITY_VERIFIER,
  type GoogleIdentity,
  type GoogleIdentityVerifier,
  InvalidGoogleCodeError,
} from './google-identity.js';

export const GOOGLE_CALLBACK_PATH = '/auth/google/callback';

export interface GoogleAuthCookies {
  state: string | undefined;
  refreshToken: string | undefined;
}

@Injectable()
export class GoogleAuthService {
  private readonly allowedRedirectUris: ReadonlySet<string>;

  constructor(
    private readonly accounts: GoogleAccountsRepository,
    private readonly auth: AuthService,
    private readonly states: GoogleAuthStateService,
    private readonly settings: ClientSettingsService,
    config: AppConfig,
    @Inject(GOOGLE_IDENTITY_VERIFIER) private readonly verifier: GoogleIdentityVerifier | null,
    @InjectPinoLogger(GoogleAuthService.name) private readonly logger: PinoLogger,
  ) {
    this.allowedRedirectUris = new Set(
      config.corsOrigins.map((origin) => origin.replace(/\/+$/, '') + GOOGLE_CALLBACK_PATH),
    );
  }

  async get(userId: string): Promise<GoogleAccount | null> {
    const account = await this.accounts.findByUser(userId);
    return account && toModel(account);
  }

  async start(userId: string | null, now: Date = new Date()): Promise<GoogleAuthStateIssued> {
    await this.ensureEnabled();
    return this.states.issue(userId === null ? 'login' : 'link', userId, now);
  }

  async link(
    userId: string,
    input: GoogleAuthInput,
    cookies: GoogleAuthCookies,
    now: Date = new Date(),
  ): Promise<GoogleAccount> {
    const identity = await this.verify(input, cookies, { purpose: 'link', userId }, now);
    const result = await this.accounts.insert({
      userId,
      googleSub: identity.sub,
      email: identity.email,
      linkedAt: now,
    });
    if (result === LinkGoogleResult.Linked) {
      this.logger.info({ userId }, 'google account linked');
      return { email: identity.email, linkedAt: now };
    }

    // Read after the failed insert, so a parallel link of the same account by this user still counts.
    const existing = await this.accounts.findByUser(userId);
    if (existing?.googleSub === identity.sub) return toModel(existing);
    this.logger.warn({ userId, result }, 'google account link rejected');
    throw result === LinkGoogleResult.GoogleAccountTaken
      ? authError(
          AuthErrorCode.GoogleAccountLinkedToAnotherUser,
          AUTH_ERROR_MESSAGES.googleAccountLinkedToAnotherUser,
        )
      : authError(
          AuthErrorCode.GoogleAccountAlreadyLinked,
          AUTH_ERROR_MESSAGES.googleAccountAlreadyLinked,
        );
  }

  async unlink(
    userId: string,
    currentRefreshToken: string | undefined,
    now: Date = new Date(),
  ): Promise<boolean> {
    if (await this.accounts.deleteByUser(userId)) {
      this.logger.info({ userId }, 'google account unlinked');
    }
    // Also when nothing was unlinked: a retry after a failed revoke must still end the sessions.
    await this.auth.endOtherSessions(userId, currentRefreshToken, now);
    return true;
  }

  async login(
    input: GoogleAuthInput,
    cookies: GoogleAuthCookies,
    now: Date = new Date(),
  ): Promise<LoginResult> {
    const identity = await this.verify(input, cookies, { purpose: 'login', userId: null }, now);
    const user = await this.accounts.findUserBySub(identity.sub);
    if (!user) {
      this.logger.warn('google login rejected: google account not linked');
      throw authError(
        AuthErrorCode.GoogleAccountNotLinked,
        AUTH_ERROR_MESSAGES.googleAccountNotLinked,
      );
    }
    // A lock from wrong passwords blocks every login method.
    if (user.lockedUntil && user.lockedUntil > now) {
      this.logger.warn({ userId: user.id }, 'google login rejected: account locked');
      throw accountLocked(user.lockedUntil);
    }

    const result = await this.auth.startSession(
      { id: user.id, email: user.email, phone: user.phone },
      cookies.refreshToken,
      now,
    );
    this.logger.info({ userId: user.id }, 'user logged in with google');
    return result;
  }

  private async ensureEnabled(): Promise<GoogleIdentityVerifier> {
    if (!(await this.settings.get('auth.googleLogin'))) {
      throw authError(AuthErrorCode.GoogleLoginDisabled, AUTH_ERROR_MESSAGES.googleLoginDisabled);
    }
    if (!this.verifier) {
      this.logger.warn(
        'google login unavailable: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set',
      );
      throw authError(AuthErrorCode.GoogleLoginDisabled, AUTH_ERROR_MESSAGES.googleLoginDisabled);
    }
    return this.verifier;
  }

  private async verify(
    input: GoogleAuthInput,
    cookies: GoogleAuthCookies,
    expected: { purpose: GoogleAuthPurpose; userId: string | null },
    now: Date,
  ): Promise<GoogleIdentity> {
    const verifier = await this.ensureEnabled();
    if (!input.code.trim()) {
      throw badInput(AUTH_ERROR_MESSAGES.codeRequired, 'code');
    }
    if (!input.state) {
      throw badInput(AUTH_ERROR_MESSAGES.stateRequired, 'state');
    }
    if (!this.allowedRedirectUris.has(input.redirectUri)) {
      throw badInput(AUTH_ERROR_MESSAGES.invalidRedirectUri, 'redirectUri');
    }
    const nonce = this.states.check(cookies.state, { ...expected, state: input.state }, now);
    if (nonce === null) {
      this.logger.warn(
        { userId: expected.userId ?? undefined, purpose: expected.purpose },
        'google sign-in rejected: state',
      );
      throw invalidState();
    }

    let identity: GoogleIdentity;
    try {
      identity = await verifier.verify({
        code: input.code,
        redirectUri: input.redirectUri,
        codeVerifier: input.codeVerifier ?? undefined,
      });
    } catch (error) {
      if (!(error instanceof InvalidGoogleCodeError)) throw error;
      this.logger.warn({ reason: error.message }, 'google code rejected');
      throw authError(AuthErrorCode.InvalidGoogleCode, AUTH_ERROR_MESSAGES.invalidGoogleCode);
    }
    if (identity.nonce === undefined || !equal(identity.nonce, nonce)) {
      this.logger.warn({ purpose: expected.purpose }, 'google sign-in rejected: nonce');
      throw invalidState();
    }
    if (!identity.emailVerified) {
      this.logger.warn(
        { purpose: expected.purpose },
        'google sign-in rejected: email not verified',
      );
      throw authError(
        AuthErrorCode.GoogleEmailNotVerified,
        AUTH_ERROR_MESSAGES.googleEmailNotVerified,
      );
    }
    return identity;
  }
}

function toModel(account: LinkedGoogleAccount): GoogleAccount {
  return { email: account.email, linkedAt: account.linkedAt };
}

function badInput(message: string, field: string) {
  return authError(AuthErrorCode.BadUserInput, message, { field });
}

function invalidState() {
  return authError(AuthErrorCode.InvalidGoogleState, AUTH_ERROR_MESSAGES.invalidGoogleState);
}
