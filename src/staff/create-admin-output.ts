import type { AppEnv } from '../config/env.schema.js';
import type { CreateAdminResult } from './staff-bootstrap.service.js';

/** The invitation link is a credential: it is printed only on a developer machine. */
export function formatCreateAdminResult(result: CreateAdminResult, appEnv: AppEnv): string {
  const delivery =
    result.link !== undefined && appEnv === 'local'
      ? `Invitation link: ${result.link}`
      : 'An invitation email was requested.';
  switch (result.outcome) {
    case 'created':
      return `Admin invited. ${delivery}\n`;
    case 'resent':
      return `Invitation re-issued, the previous link no longer works. ${delivery}\n`;
    case 'adminExists':
      return 'An admin already exists, nothing changed.\n';
    case 'emailTaken':
      return 'This email already belongs to a staff member who cannot be re-invited, nothing changed.\n';
    case 'invalidEmail':
      return 'The email is not valid, nothing changed.\n';
  }
}
