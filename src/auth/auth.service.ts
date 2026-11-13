import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { ClientSettingsService } from '../settings/client-settings.service.js';
import { AUTH_ERROR_MESSAGES, AuthErrorCode, authError } from './auth-errors.js';
import type { AuthPayload } from './auth-payload.model.js';
import type { LoginInput } from './login.input.js';
import {
  PASSWORD_MAX_LENGTH,
  REGISTER_INPUT_MESSAGES,
  parseRegisterInput,
} from './register.schema.js';
import type { RegisterInput } from './register.input.js';
import { SessionsRepository } from './sessions.repository.js';
import { TokenService, USER_PERMISSIONS, hashRefreshToken, newRefreshToken } from './tokens.js';
import type { User } from './user.model.js';
import { InsertUserResult, UsersRepository } from './users.repository.js';

export const MAX_FAILED_LOGINS = 5;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;

export interface LoginResult {
  payload: AuthPayload;
  /** For the cookie only; never part of the response body. */
  refreshToken: string;
  sessionExpiresAt: Date;
}

@Injectable()
export class AuthService {
  // Verified against for an unknown email, so the answer takes as long as for a known one.
  private readonly unknownUserHash: Promise<string> = hash(randomBytes(16).toString('hex'));

  constructor(
    private readonly users: UsersRepository,
    private readonly sessions: SessionsRepository,
    private readonly tokens: TokenService,
    private readonly settings: ClientSettingsService,
    private readonly config: AppConfig,
    @InjectPinoLogger(AuthService.name) private readonly logger: PinoLogger,
  ) {}

  async register(input: RegisterInput): Promise<User> {
    const data = parseRegisterInput(input);
    const phone = data.phone ?? null;
    if (phone === null && (await this.settings.get('auth.phoneRequiredAt')) === 'signup') {
      throw authError(AuthErrorCode.BadUserInput, REGISTER_INPUT_MESSAGES.phoneRequired, {
        field: 'phone',
      });
    }

    const user: User = { id: randomUUID(), email: data.email, phone };
    const result = await this.users.insert({
      ...user,
      passwordHash: await hash(data.password),
      createdAt: new Date(),
    });
    if (result === InsertUserResult.EmailTaken) {
      // No email in the log: it is personal data.
      this.logger.warn('registration rejected: email already registered');
      throw authError(
        AuthErrorCode.EmailAlreadyRegistered,
        AUTH_ERROR_MESSAGES.emailAlreadyRegistered,
      );
    }

    this.logger.info({ userId: user.id }, 'user registered');
    return user;
  }

  async login(
    input: LoginInput,
    previousRefreshToken?: string,
    now: Date = new Date(),
  ): Promise<LoginResult> {
    if (input.password.length > PASSWORD_MAX_LENGTH) throw invalidCredentials();

    const user = await this.users.findByEmail(input.email.trim().toLowerCase());
    if (!user) {
      await verify(await this.unknownUserHash, input.password);
      this.logger.warn('login rejected: unknown email');
      throw invalidCredentials();
    }
    // Checked before the password, so a locked account does not tell whether a guess was right.
    if (user.lockedUntil && user.lockedUntil > now) {
      this.logger.warn({ userId: user.id }, 'login rejected: account locked');
      throw accountLocked(user.lockedUntil);
    }

    if (!(await verify(user.passwordHash, input.password))) {
      const lockedUntil = await this.users.recordFailedLogin(user.id, {
        now,
        maxFailedAttempts: MAX_FAILED_LOGINS,
        lockDurationMs: LOGIN_LOCK_MS,
      });
      this.logger.warn({ userId: user.id, locked: lockedUntil !== null }, 'login rejected');
      throw lockedUntil ? accountLocked(lockedUntil) : invalidCredentials();
    }

    // Parallel wrong guesses may have locked the account while argon2 ran.
    const lockedMeanwhile = await this.users.recordSuccessfulLogin(user.id, now);
    if (lockedMeanwhile) {
      this.logger.warn({ userId: user.id }, 'login rejected: account locked');
      throw accountLocked(lockedMeanwhile);
    }

    const result = await this.startSession(
      { id: user.id, email: user.email, phone: user.phone },
      previousRefreshToken,
      now,
    );
    this.logger.info({ userId: user.id }, 'user logged in');
    return result;
  }

  /** The caller must already have checked the user's identity and lock. */
  async startSession(
    user: User,
    previousRefreshToken: string | undefined,
    now: Date,
  ): Promise<LoginResult> {
    const refreshToken = newRefreshToken();
    const sessionExpiresAt = new Date(now.getTime() + this.config.jwt.sessionTtlSeconds * 1000);
    await this.sessions.create({
      id: randomUUID(),
      userId: user.id,
      refreshTokenHash: refreshToken.hash,
      expiresAt: sessionExpiresAt,
      createdAt: now,
    });
    // Revoke the previous browser session because login replaces its refresh cookie.
    if (previousRefreshToken) {
      await this.sessions.revoke(hashRefreshToken(previousRefreshToken), now);
    }
    return this.result(user, refreshToken.token, { sessionExpiresAt, now });
  }

  async refreshSession(
    refreshToken: string | undefined,
    now: Date = new Date(),
  ): Promise<LoginResult> {
    if (!refreshToken) throw invalidRefreshToken();
    const next = newRefreshToken();
    const session = await this.sessions.rotate(hashRefreshToken(refreshToken), next.hash, now);
    if (!session) {
      this.logger.warn('session refresh rejected');
      throw invalidRefreshToken();
    }

    this.logger.info({ userId: session.user.id }, 'session refreshed');
    return this.result(session.user, next.token, { sessionExpiresAt: session.expiresAt, now });
  }

  async endOtherSessions(
    userId: string,
    keepRefreshToken: string | undefined,
    now: Date = new Date(),
  ): Promise<number> {
    const ended = await this.sessions.revokeAllOfUser(
      userId,
      now,
      keepRefreshToken === undefined ? undefined : hashRefreshToken(keepRefreshToken),
    );
    this.logger.info({ userId, ended }, 'other sessions ended');
    return ended;
  }

  async logout(refreshToken: string | undefined, now: Date = new Date()): Promise<void> {
    if (refreshToken) await this.sessions.revoke(hashRefreshToken(refreshToken), now);
  }

  private result(
    user: User,
    refreshToken: string,
    { sessionExpiresAt, now }: { sessionExpiresAt: Date; now: Date },
  ): LoginResult {
    const accessToken = this.tokens.signAccessToken(
      { userId: user.id, aud: 'wallet', permissions: USER_PERMISSIONS },
      now,
    );
    return {
      payload: {
        accessToken: accessToken.token,
        accessTokenExpiresAt: accessToken.expiresAt,
        user,
      },
      refreshToken,
      sessionExpiresAt,
    };
  }
}

function invalidRefreshToken() {
  return authError(AuthErrorCode.InvalidRefreshToken, AUTH_ERROR_MESSAGES.invalidRefreshToken);
}

function invalidCredentials() {
  return authError(AuthErrorCode.InvalidCredentials, AUTH_ERROR_MESSAGES.invalidCredentials);
}

export function accountLocked(lockedUntil: Date) {
  return authError(AuthErrorCode.AccountLocked, AUTH_ERROR_MESSAGES.accountLocked(lockedUntil), {
    lockedUntil: lockedUntil.toISOString(),
  });
}
