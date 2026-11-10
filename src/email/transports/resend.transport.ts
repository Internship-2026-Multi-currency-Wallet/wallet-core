import {
  EmailTransportError,
  safeLabel,
  type EmailMessage,
  type EmailTransport,
} from './email-transport.js';

const RESEND_URL = 'https://api.resend.com/emails';

export class ResendTransport implements EmailTransport {
  constructor(private readonly apiKey: string) {}

  async send(msg: EmailMessage): Promise<void> {
    const name = msg.from.name.replace(/[\\"]/g, '\\$&');
    let res: Response;
    try {
      res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': msg.idempotencyKey,
        },
        body: JSON.stringify({
          from: `"${name}" <${msg.from.address}>`,
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new EmailTransportError('resend', true);
    }
    if (res.ok) return;
    let errorName: string | undefined;
    try {
      errorName = safeLabel(((await res.json()) as { name?: unknown }).name);
    } catch {
      // the body is optional diagnostics only
    }
    throw new EmailTransportError(
      'resend',
      res.status >= 500 || res.status === 429,
      res.status,
      errorName,
    );
  }
}
