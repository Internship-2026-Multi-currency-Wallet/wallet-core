import { NotImplementedException } from '@nestjs/common';
import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { AuthPayload } from './auth-payload.model.js';
import { LoginInput } from './login.input.js';
import { Public } from './public.decorator.js';
import { RegisterInput } from './register.input.js';
import { User } from './user.model.js';

/**
 * Registration, login and sessions. Contract only: every mutation throws until it is implemented.
 * The refresh token travels in an httpOnly cookie, never in arguments or results.
 */
@Resolver()
export class AuthResolver {
  @Public()
  @Mutation(() => User, {
    description:
      'Creates an account. Does not log in: call login afterwards. Errors: BAD_USER_INPUT, EMAIL_ALREADY_REGISTERED.',
  })
  register(@Args('input') _input: RegisterInput): User {
    throw new NotImplementedException('register is not implemented yet');
  }

  @Public()
  @Mutation(() => AuthPayload, {
    description:
      'Logs in with email and password (sets the refresh token cookie). Errors: INVALID_CREDENTIALS, ACCOUNT_LOCKED (extensions.lockedUntil).',
  })
  login(@Args('input') _input: LoginInput): AuthPayload {
    throw new NotImplementedException('login is not implemented yet');
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
