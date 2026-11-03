import type { GraphQLError } from 'graphql';
import { REGISTER_INPUT_MESSAGES as m, parseRegisterInput } from './register.schema.js';

const valid = { email: 'artem@test.com', password: 'Qwerty1!' };

/** The `BAD_USER_INPUT` error thrown for `input`. */
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
      expectRejected({ ...valid, email }, 'email', m.emailInvalid);
    });

    it('rejects an email longer than the column', () => {
      expectRejected({ ...valid, email: `${'a'.repeat(250)}@test.com` }, 'email', m.emailTooLong);
    });
  });

  describe('password', () => {
    it.each([
      ['shorter than 8 characters', 'Qwe1!', m.passwordTooShort],
      ['longer than 128 characters', `Qwerty1!${'a'.repeat(121)}`, m.passwordTooLong],
      ['without a digit', 'Qwerty!!', m.passwordNoDigit],
      ['without an uppercase letter', 'qwerty1!', m.passwordNoUppercase],
      ['without a special character', 'Qwerty12', m.passwordNoSpecial],
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
    it.each(['0501234567', '+0501234567', '+380 50 123 45 67', '+3805', '+3805012345678901'])(
      'rejects %j',
      (phone) => {
        expectRejected({ ...valid, phone }, 'phone', m.phoneInvalid);
      },
    );
  });

  it('reports only the first broken rule, in field order', () => {
    expectRejected({ email: 'nope', password: 'short', phone: '050' }, 'email', m.emailInvalid);
    expectRejected({ ...valid, password: 'short' }, 'password', m.passwordTooShort);
  });
});
