import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { EmailTransportError } from './email-transport.js';
import { ResendTransport } from './resend.transport.js';

const msg = {
  from: { name: 'Wallet', address: 'no-reply@example.com' },
  to: 'user@example.com',
  subject: 'Hi',
  html: '<p>SECRETHTML</p>',
  text: 'SECRETTEXT',
  idempotencyKey: 'key-1',
};

const setup = (response: Response | Error) => {
  const fetchMock = jest.spyOn(globalThis, 'fetch');
  if (!(response instanceof Response)) fetchMock.mockRejectedValue(response);
  else fetchMock.mockResolvedValue(response);
  return { fetchMock, transport: new ResendTransport('re_test_key') };
};

const failure = async (transport: ResendTransport) => {
  const err = await transport.send(msg).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EmailTransportError);
  return err as EmailTransportError;
};

const expectNoLeak = (err: EmailTransportError) => {
  const dump = [JSON.stringify(err), err.message, String(err)].join('|');
  for (const secret of ['re_test_key', 'SECRETHTML', 'user@example.com', 'SECRETTEXT']) {
    expect(dump).not.toContain(secret);
  }
};

describe('ResendTransport', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('posts the message to Resend with auth and idempotency headers', async () => {
    const { fetchMock, transport } = setup(new Response('{}', { status: 200 }));
    await expect(transport.send(msg)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      Authorization: 'Bearer re_test_key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'key-1',
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      from: '"Wallet" <no-reply@example.com>',
      to: ['user@example.com'],
      subject: 'Hi',
      html: '<p>SECRETHTML</p>',
      text: 'SECRETTEXT',
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([500, 503, 429])('treats %i as retryable', async (status) => {
    const { transport } = setup(new Response('{"message":"bad user@example.com"}', { status }));
    const err = await failure(transport);
    expect(err).toMatchObject({ provider: 'resend', status, retryable: true });
    expectNoLeak(err);
  });

  it.each([400, 401, 403, 422])(
    'treats %i as permanent and never leaks the echoed address',
    async (status) => {
      const body = JSON.stringify({
        name: 'validation_error',
        message: 'bad user@example.com re_test_key',
      });
      const { transport } = setup(new Response(body, { status }));
      const err = await failure(transport);
      expect(err).toMatchObject({
        provider: 'resend',
        status,
        retryable: false,
        errorName: 'validation_error',
      });
      expectNoLeak(err);
    },
  );

  it('drops a provider error name that is not a short identifier', async () => {
    const { transport } = setup(new Response('{"name":"user@example.com"}', { status: 422 }));
    expect((await failure(transport)).errorName).toBeUndefined();
  });

  it.each([
    new TypeError('fetch failed for user@example.com'),
    new DOMException('timed out', 'TimeoutError'),
  ])('treats a fetch rejection as retryable without leaking its message', async (cause) => {
    const { transport } = setup(cause);
    const err = await failure(transport);
    expect(err.retryable).toBe(true);
    expect(err.status).toBeUndefined();
    expectNoLeak(err);
  });

  it('escapes quotes and backslashes in the sender name', async () => {
    const { fetchMock, transport } = setup(new Response('{}', { status: 200 }));
    await transport.send({ ...msg, from: { name: 'A "B" \\C', address: 'no-reply@example.com' } });
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as { from: string };
    expect(body.from).toBe('"A \\"B\\" \\\\C" <no-reply@example.com>');
  });

  it('treats a concurrent idempotent request conflict as retryable', async () => {
    const { transport } = setup(
      new Response('{"name":"concurrent_idempotent_requests"}', { status: 409 }),
    );
    expect(await failure(transport)).toMatchObject({
      retryable: true,
      status: 409,
      errorName: 'concurrent_idempotent_requests',
    });
  });

  it('keeps an invalid idempotent request conflict permanent', async () => {
    const { transport } = setup(
      new Response('{"name":"invalid_idempotent_request"}', { status: 409 }),
    );
    expect(await failure(transport)).toMatchObject({ retryable: false, status: 409 });
  });

  it('survives a non-JSON error body', async () => {
    const { transport } = setup(new Response('<html>Bad Gateway</html>', { status: 502 }));
    const err = await failure(transport);
    expect(err).toMatchObject({ retryable: true, status: 502 });
    expect(err.errorName).toBeUndefined();
  });
});
