import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import type { Response } from 'express';
import { GraphQLError } from 'graphql';
import { AppConfig } from '../config/app-config.js';
import type { GraphqlContext } from '../graphql/graphql.config.js';
import { AuthPayload } from './auth-payload.model.js';
import { LoginInput } from './login.input.js';
import { Public } from './public.decorator.js';
import {
  clearRefreshTokenCookie,
  readRefreshToken,
  setRefreshTokenCookie,
} from './refresh-token-cookie.js';
import { RegisterInput } from './register.input.js';
import { User } from './user.model.js';
import { AuthErrorCode } from './auth-errors.js';
import { AuthService, type LoginResult } from './auth.service.js';

@Resolver()
export class AuthResolver {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  @Public()
  @Mutation(() => User, {
    description:
      'Creates an account. Does not log in: call login afterwards. Errors: BAD_USER_INPUT, EMAIL_ALREADY_REGISTERED.',
  })
  register(@Args('input') input: RegisterInput): Promise<User> {
    return this.auth.register(input);
  }

  @Public()
  @Mutation(() => AuthPayload, {
    description:
      'Logs in with email and password (sets the refresh token cookie). Errors: INVALID_CREDENTIALS, ACCOUNT_LOCKED (extensions.lockedUntil).',
  })
  async login(
    @Args('input') input: LoginInput,
    @Context() context: GraphqlContext,
  ): Promise<AuthPayload> {
    const res = httpResponseOf(context);
    const result = await this.auth.login(input, new Date(), readRefreshToken(context.req));
    return this.withCookie(res, result);
  }

  @Public()
  @Mutation(() => AuthPayload, {
    description:
      'Issues a new access token using the refresh token cookie; no password needed. Errors: INVALID_REFRESH_TOKEN.',
  })
  async refreshSession(@Context() context: GraphqlContext): Promise<AuthPayload> {
    const res = httpResponseOf(context);
    try {
      return this.withCookie(res, await this.auth.refreshSession(readRefreshToken(context.req)));
    } catch (error) {
      // A dead cookie would make the client try again and again.
      if (
        error instanceof GraphQLError &&
        error.extensions.code === AuthErrorCode.InvalidRefreshToken
      ) {
        clearRefreshTokenCookie(res, this.config.isProduction);
      }
      throw error;
    }
  }

  @Public()
  @Mutation(() => Boolean, {
    description:
      'Ends the session of the refresh token cookie and clears the cookie. Returns true even when there was no session.',
  })
  async logout(@Context() context: GraphqlContext): Promise<boolean> {
    const res = httpResponseOf(context);
    await this.auth.logout(readRefreshToken(context.req));
    clearRefreshTokenCookie(res, this.config.isProduction);
    return true;
  }

  private withCookie(res: Response, result: LoginResult): AuthPayload {
    setRefreshTokenCookie(
      res,
      result.refreshToken,
      result.sessionExpiresAt,
      this.config.isProduction,
    );
    return result.payload;
  }
}

// A websocket has no response to carry the cookie, so the session would be lost.
function httpResponseOf(context: GraphqlContext): Response {
  if (!context.res) {
    throw new GraphQLError('Use HTTP for this operation, not the websocket', {
      extensions: { code: 'BAD_REQUEST' },
    });
  }
  return context.res;
}
