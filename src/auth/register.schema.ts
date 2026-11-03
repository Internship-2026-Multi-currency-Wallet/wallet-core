import { z } from 'zod';
import { AuthErrorCode, authError } from './auth-errors.js';

/** Messages of the register validation rules (`BAD_USER_INPUT`), kept in one place. */
export const REGISTER_INPUT_MESSAGES = {
  emailInvalid: 'Email must be a valid email address',
  emailTooLong: 'Email must be at most 255 characters',
  passwordTooShort: 'Password must be at least 8 characters',
  passwordTooLong: 'Password must be at most 128 characters',
  passwordNoDigit: 'Password must contain at least one digit',
  passwordNoUppercase: 'Password must contain at least one uppercase letter',
  passwordNoSpecial: 'Password must contain at least one special character',
  phoneInvalid: 'Phone must be in international format, e.g. +380501234567',
  /** Checked by the service: depends on the client setting `auth.phoneRequiredAt`. */
  phoneRequired: 'Phone is required',
} as const;

const m = REGISTER_INPUT_MESSAGES;

/**
 * Rules of `RegisterInput` (see the contract). The email is trimmed and lower-cased, so it is
 * stored and compared in one form. Unknown keys are dropped.
 */
export const registerInputSchema = z.object({
  // 255 = the users.email column.
  email: z.string().trim().toLowerCase().pipe(z.email(m.emailInvalid).max(255, m.emailTooLong)),
  password: z
    .string()
    .min(8, m.passwordTooShort)
    // Caps the work argon2 does for one request.
    .max(128, m.passwordTooLong)
    .regex(/\d/, m.passwordNoDigit)
    .regex(/\p{Lu}/u, m.passwordNoUppercase)
    // "Special" = anything that is not a letter or a digit.
    .regex(/[^\p{L}\p{N}]/u, m.passwordNoSpecial),
  // E.164: "+", then 8–15 digits, the first one not 0.
  phone: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, m.phoneInvalid)
    .nullish(),
});

export type RegisterData = z.infer<typeof registerInputSchema>;

/** Validates register input; the first broken rule → `BAD_USER_INPUT` with its `field`. */
export function parseRegisterInput(input: unknown): RegisterData {
  const result = registerInputSchema.safeParse(input);
  if (result.success) return result.data;
  const [issue] = result.error.issues;
  throw authError(AuthErrorCode.BadUserInput, issue.message, { field: String(issue.path[0]) });
}
