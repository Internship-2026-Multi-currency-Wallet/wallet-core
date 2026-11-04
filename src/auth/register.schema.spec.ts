import type { GraphQLError } from 'graphql';
import { REGISTER_INPUT_MESSAGES, parseRegisterInput } from './register.schema.js';

const valid = { email: 'artem@test.com', password: 'Qwerty1!' };

function rejection(input: Record<string, unknown>): GraphQLError {
  try {
    parseRegisterInput(input);
  } catch (error) {
    return error as GraphQLError;
  }
  throw new Error('expected the input to be rejected');
}

function expectRejected(input: Record<string, unknown>, field: string, message: string): void {
  const error = rejection(input);
  expect(error.message).toBe(message);
  expect(error.extensions).toEqual({ code: 'BAD_USER_INPUT', field });
}

describe('parseRegisterInput', () => {
  it('accepts valid input, with and without a phone', () => {
    expect(parseRegisterInput(valid)).toEqual(valid);
    expect(parseRegisterInput({ ...valid, phone: '+380501234567' })).toEqual({
      ...valid,
      phone: '+380501234567',
    });
    expect(parseRegisterInput({ ...valid, phone: null })).toEqual({ ...valid, phone: null });
  });

  it('trims and lower-cases the email', () => {
    expect(parseRegisterInput({ ...valid, email: '  Artem@Test.COM ' }).email).toBe(
      'artem@test.com',
    );
  });

  it('drops unknown keys', () => {
    expect(parseRegisterInput({ ...valid, role: 'admin' })).toEqual(valid);
  });

  describe('email', () => {
    it.each(['', 'artem', 'artem@', '@test.com', 'artem@test'])('rejects %j', (email) => {
      expectRejected({ ...valid, email }, 'email', REGISTER_INPUT_MESSAGES.emailInvalid);
    });

    it('rejects an email longer than the column', () => {
      expectRejected(
        { ...valid, email: `${'a'.repeat(250)}@test.com` },
        'email',
        REGISTER_INPUT_MESSAGES.emailTooLong,
      );
    });
  });

  describe('password', () => {
    it.each([
      ['shorter than 8 characters', 'Qwe1!', REGISTER_INPUT_MESSAGES.passwordTooShort],
      [
        'longer than 128 characters',
        `Qwerty1!${'a'.repeat(121)}`,
        REGISTER_INPUT_MESSAGES.passwordTooLong,
      ],
      ['without a digit', 'Qwerty!!', REGISTER_INPUT_MESSAGES.passwordNoDigit],
      ['without an uppercase letter', 'qwerty1!', REGISTER_INPUT_MESSAGES.passwordNoUppercase],
      ['without a special character', 'Qwerty12', REGISTER_INPUT_MESSAGES.passwordNoSpecial],
    ])('rejects a password %s', (_case, password, message) => {
      expectRejected({ ...valid, password }, 'password', message);
    });

    it('accepts exactly 8 and exactly 128 characters', () => {
      for (const password of ['Qwerty1!', `Qwerty1!${'a'.repeat(120)}`]) {
        expect(parseRegisterInput({ ...valid, password }).password).toBe(password);
      }
    });

    it('accepts non-Latin letters and any non-alphanumeric special character', () => {
      expect(parseRegisterInput({ ...valid, password: 'Пароль1 ' }).password).toBe('Пароль1 ');
      expect(parseRegisterInput({ ...valid, password: 'Qwerty1_' }).password).toBe('Qwerty1_');
    });
  });

  describe('phone', () => {
    // 7 digits (Niue) and 15 digits, the E.164 limits.
    it.each(['+6834000', '+380501234567890'])('accepts %j', (phone) => {
      expect(parseRegisterInput({ ...valid, phone })).toEqual({ ...valid, phone });
    });

    it.each(['0501234567', '+0501234567', '+380 50 123 45 67', '+683400', '+3805012345678901'])(
      'rejects %j',
      (phone) => {
        expectRejected({ ...valid, phone }, 'phone', REGISTER_INPUT_MESSAGES.phoneInvalid);
      },
    );
  });

  it('reports only the first broken rule, in field order', () => {
    expectRejected(
      { email: 'nope', password: 'short', phone: '050' },
      'email',
      REGISTER_INPUT_MESSAGES.emailInvalid,
    );
    expectRejected(
      { ...valid, password: 'short' },
      'password',
      REGISTER_INPUT_MESSAGES.passwordTooShort,
    );
  });
});
