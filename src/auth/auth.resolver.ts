import { NotImplementedException } from '@nestjs/common';
import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import type { Response } from 'express';
import { GraphQLError } from 'graphql';
import { AppConfig } from '../config/app-config.js';
import type { GraphqlContext } from '../graphql/graphql.config.js';
import { AuthPayload } from './auth-payload.model.js';
import { LoginInput } from './login.input.js';
import { Public } from './public.decorator.js';
import { REFRESH_TOKEN_COOKIE, refreshTokenCookieOptions } from './refresh-token-cookie.js';
import { RegisterInput } from './register.input.js';
import { User } from './user.model.js';
import { AuthService } from './auth.service.js';

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
    const result = await this.auth.login(input);
    res.cookie(
      REFRESH_TOKEN_COOKIE,
      result.refreshToken,
      refreshTokenCookieOptions(this.config.isProduction, result.sessionExpiresAt),
    );
    return result.payload;
  }

  @Public()
  @Mutation(() => AuthPayload, {
    description:
      'Issues a new access token using the refresh token cookie; no password needed. Errors: INVALID_REFRESH_TOKEN.',
  })
  refreshSession(): AuthPayload {
    throw new NotImplementedException('refreshSession is not implemented yet');
  }

  @Public()
  @Mutation(() => Boolean, {
    description:
      'Ends the session of the refresh token cookie and clears the cookie. Returns true even when there was no session.',
  })
  logout(): boolean {
    throw new NotImplementedException('logout is not implemented yet');
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
