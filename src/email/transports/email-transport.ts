export const EMAIL_TRANSPORT_CLIENT = Symbol('EMAIL_TRANSPORT_CLIENT');

export interface EmailMessage {
  from: { name: string; address: string };
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
}

export interface EmailTransport {
  send(msg: EmailMessage): Promise<void>;
}

/** Carries only classification fields; the message is fixed so no provider text, address or key can leak. */
export class EmailTransportError extends Error {
  constructor(
    readonly provider: 'resend' | 'smtp',
    readonly retryable: boolean,
    readonly status?: number,
    readonly errorName?: string,
  ) {
    super(`email transport failed (${provider}${status === undefined ? '' : `, ${status}`})`);
    this.name = 'EmailTransportError';
  }
}

/** Provider text may contain addresses or tokens and ends up in logs, so only identifier-like labels pass. */
export const safeLabel = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
