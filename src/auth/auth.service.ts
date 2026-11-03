import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ClientSettingsService } from '../settings/client-settings.service.js';
import { AUTH_ERROR_MESSAGES, AuthErrorCode, authError } from './auth-errors.js';
import { REGISTER_INPUT_MESSAGES, parseRegisterInput } from './register.schema.js';
import type { RegisterInput } from './register.input.js';
import type { User } from './user.model.js';
import { UsersRepository } from './users.repository.js';

/** Registration, login and sessions. The password is only ever hashed, never stored or logged. */
@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersRepository,
    private readonly settings: ClientSettingsService,
    @InjectPinoLogger(AuthService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Creates an account; does not log in. Errors: `BAD_USER_INPUT` (first broken rule, or no
   * phone while the client requires it at signup), `EMAIL_ALREADY_REGISTERED`.
   */
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
    if (result === 'emailTaken') {
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
}
