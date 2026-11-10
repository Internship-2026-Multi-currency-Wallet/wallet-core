import { describe, expect, it } from '@jest/globals';
import type { AppConfig } from '../../config/app-config.js';
import { createEmailTransport } from './create-transport.js';
import { ResendTransport } from './resend.transport.js';
import { SmtpTransport } from './smtp.transport.js';

const config = (transport: 'resend' | 'smtp' | 'fake') =>
  ({
    email: {
      transport,
      from: 'a@example.com',
      resendApiKey: 're_test_key',
      smtpUrl: 'smtp://localhost:1025',
    },
  }) as AppConfig;

describe('createEmailTransport', () => {
  it('builds the Resend transport for resend', () => {
    expect(createEmailTransport(config('resend'))).toBeInstanceOf(ResendTransport);
  });
  it('builds the SMTP transport for smtp', () => {
    expect(createEmailTransport(config('smtp'))).toBeInstanceOf(SmtpTransport);
  });
  it('builds nothing for fake', () => {
    expect(createEmailTransport(config('fake'))).toBeUndefined();
  });
});

describe('createEmailTransport without a Resend key', () => {
  it('throws instead of building a transport with no key', () => {
    const cfg = config('resend');
    (cfg.email as { resendApiKey?: string }).resendApiKey = undefined;
    expect(() => createEmailTransport(cfg)).toThrow(/RESEND_API_KEY/);
  });
});
