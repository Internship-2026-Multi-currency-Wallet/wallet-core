import { Writable } from 'node:stream';
import { pino } from 'pino';
import {
  httpLoggerOptions,
  loggerOptions,
  REDACTED,
  REQUEST_ID_HEADER,
  requestIdFrom,
  type LoggerSettings,
} from './logger.options.js';

const settings: LoggerSettings = {
  service: 'test-service',
  appEnv: 'staging',
  client: 'demo',
  level: 'info',
  pretty: false,
};

/** A pino logger with the service options that writes JSON lines into an array. */
function capture(): { logger: pino.Logger; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  const logger = pino(loggerOptions(settings), stream);
  return {
    logger,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('logger options', () => {
  it('writes JSON with service, appEnv, client and a level label', () => {
    const { logger, lines } = capture();
    logger.child({ requestId: 'r-1' }).info({ userId: '1' }, 'hello');
    expect(lines()[0]).toMatchObject({
      level: 'info',
      service: 'test-service',
      appEnv: 'staging',
      client: 'demo',
      requestId: 'r-1',
      userId: '1',
      msg: 'hello',
    });
    expect(lines()[0].time).toEqual(expect.stringMatching(/^\d{4}-\d\d-\d\dT/));
  });

  it('redacts secrets at any of the first four levels', () => {
    const { logger, lines } = capture();
    logger.info(
      {
        password: 'p0',
        authorization: 'Bearer t0',
        headers: { authorization: 'Dev 1:wallet', cookie: 'sid=1', 'x-api-key': 'k1' },
        user: { name: 'Ann', credentials: { password: 'p2', apiKey: 'k2', token: 't2' } },
        payment: { webhook: { config: { webhookSecret: 's3', secret: 's3b' } } },
        databaseUrl: 'mysql://u:p@h/db',
      },
      'login attempt',
    );
    const line = JSON.stringify(lines()[0]);
    for (const secret of [
      'p0',
      't0',
      'Dev 1:wallet',
      'sid=1',
      'k1',
      'p2',
      'k2',
      't2',
      's3',
      'mysql://',
    ]) {
      expect(line).not.toContain(secret);
    }
    expect(lines()[0]).toMatchObject({
      password: REDACTED,
      headers: { authorization: REDACTED, cookie: REDACTED, 'x-api-key': REDACTED },
      user: { name: 'Ann', credentials: { password: REDACTED, apiKey: REDACTED } },
    });
  });
});

describe('request id', () => {
  it('keeps a sane incoming x-request-id', () => {
    expect(requestIdFrom({ [REQUEST_ID_HEADER]: 'trace-123' })).toBe('trace-123');
    expect(requestIdFrom({ [REQUEST_ID_HEADER]: ['a.b:c-1'] })).toBe('a.b:c-1');
  });

  it('generates a UUID when the header is missing or unsafe', () => {
    const uuid = /^[0-9a-f-]{36}$/;
    expect(requestIdFrom(undefined)).toMatch(uuid);
    expect(requestIdFrom({ [REQUEST_ID_HEADER]: 'has spaces "and quotes"' })).toMatch(uuid);
    expect(requestIdFrom({ [REQUEST_ID_HEADER]: 'x'.repeat(200) })).toMatch(uuid);
  });

  it('echoes the request id in the response header', () => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (name: string, value: string) => (headers[name] = value) };
    const genReqId = httpLoggerOptions(settings).genReqId as (req: unknown, res: unknown) => string;
    expect(genReqId({ headers: { 'x-request-id': 'abc' } }, res)).toBe('abc');
    expect(headers['x-request-id']).toBe('abc');
  });
});
