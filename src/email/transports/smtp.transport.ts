import nodemailer, { type Transporter } from 'nodemailer';
import {
  EmailTransportError,
  safeLabel,
  type EmailMessage,
  type EmailTransport,
} from './email-transport.js';

type Mailer = Pick<Transporter, 'sendMail'>;

export class SmtpTransport implements EmailTransport {
  constructor(
    smtpUrl: string,
    private readonly mailer: Mailer = nodemailer.createTransport(smtpUrl),
  ) {}

  async send(msg: EmailMessage): Promise<void> {
    try {
      await this.mailer.sendMail({
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      });
    } catch (err) {
      const e = err as { responseCode?: unknown; code?: unknown };
      const status = typeof e?.responseCode === 'number' ? e.responseCode : undefined;
      throw new EmailTransportError(
        'smtp',
        // a server reply code decides; EENVELOPE without one is a local invalid-address error, retrying cannot help
        status === undefined ? e?.code !== 'EENVELOPE' : status < 500,
        status,
        safeLabel(e?.code),
      );
    }
  }
}
