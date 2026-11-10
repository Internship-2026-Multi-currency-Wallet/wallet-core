import { describe, expect, it, jest } from '@jest/globals';
import { EmailTransportError } from './email-transport.js';
import { SmtpTransport } from './smtp.transport.js';

const msg = {
  from: { name: 'Wallet', address: 'no-reply@example.com' },
  to: 'user@example.com',
  subject: 'Hi',
  html: '<p>SECRETHTML</p>',
  text: 'SECRETTEXT',
  idempotencyKey: 'key-1',
};

const setup = (rejection?: object) => {
  const sendMail = jest.fn<(m: object) => Promise<unknown>>();
  if (rejection)
    sendMail.mockRejectedValue(Object.assign(new Error('boom user@example.com'), rejection));
  else sendMail.mockResolvedValue({});
  return { sendMail, transport: new SmtpTransport('smtp://localhost:1025', { sendMail } as never) };
};

const failure = async (transport: SmtpTransport) => {
  const err = await transport.send(msg).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EmailTransportError);
  return err as EmailTransportError;
};

describe('SmtpTransport', () => {
  it('passes sender, recipient, subject and bodies to sendMail', async () => {
    const { sendMail, transport } = setup();
    await transport.send(msg);
    expect(sendMail).toHaveBeenCalledWith({
      from: { name: 'Wallet', address: 'no-reply@example.com' },
      to: 'user@example.com',
      subject: 'Hi',
      html: '<p>SECRETHTML</p>',
      text: 'SECRETTEXT',
    });
  });

  it('treats a 5xx reply as permanent and leaks nothing', async () => {
    const { transport } = setup({
      responseCode: 550,
      response: '550 no such user <user@example.com>',
      rejected: ['user@example.com'],
    });
    const err = await failure(transport);
    expect(err).toMatchObject({ provider: 'smtp', status: 550, retryable: false });
    expect([JSON.stringify(err), err.message, String(err)].join('|')).not.toContain(
      'user@example.com',
    );
  });

  it('treats a 4xx reply as retryable', async () => {
    const { transport } = setup({ responseCode: 451 });
    expect(await failure(transport)).toMatchObject({ status: 451, retryable: true });
  });

  it('treats a connection error without reply code as retryable', async () => {
    const { transport } = setup({ code: 'ECONNECTION' });
    const err = await failure(transport);
    expect(err).toMatchObject({ retryable: true, errorName: 'ECONNECTION' });
    expect(err.status).toBeUndefined();
  });

  it('treats a local envelope error as permanent', async () => {
    const { transport } = setup({ code: 'EENVELOPE' });
    const err = await failure(transport);
    expect(err).toMatchObject({ retryable: false, errorName: 'EENVELOPE' });
  });

  it.each([
    [451, true],
    [550, false],
  ])('lets reply code %i decide for EENVELOPE (retryable %p)', async (code, retryable) => {
    const { transport } = setup({ code: 'EENVELOPE', responseCode: code });
    expect(await failure(transport)).toMatchObject({ retryable, status: code });
  });
});
