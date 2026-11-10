import type { AppConfig } from '../../config/app-config.js';
import type { EmailTransport } from './email-transport.js';
import { ResendTransport } from './resend.transport.js';
import { SmtpTransport } from './smtp.transport.js';

export const createEmailTransport = ({ email }: AppConfig): EmailTransport | undefined => {
  if (email.transport === 'resend') return new ResendTransport(email.resendApiKey!);
  if (email.transport === 'smtp') return new SmtpTransport(email.smtpUrl);
  return undefined;
};
