import { jest } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { JwtAuthStrategy } from './jwt-auth.strategy.js';

const SECRET = 'unit-test-secret-0123456789-abcdefghij';
const USER_ID = '0b9a3f4e-6c1d-4f7a-9e2b-8d5c3a1f0e7d';

const jwtService = new JwtService();
const logger = new PinoLogger({ pinoHttp: { level: 'silent' } });
const strategy = new JwtAuthStrategy(jwtService, AppConfig.fromEnv({ JWT_SECRET: SECRET }), logger);

const now = (): number => Math.floor(Date.now() / 1000);

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = now();
  const payload: Record<string, unknown> = {
    sub: USER_ID,
    permissions: ['wallet'],
    iss: 'wallet-core',
    iat,
    exp: iat + 15 * 60,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

const sign = (payload = claims(), secret = SECRET): string =>
  jwtService.sign(payload, { secret, algorithm: 'HS256' });

const base64url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const authenticate = (authorization?: string) =>
  strategy.authenticate({ authorization, headers: {} });

async function expectRejected(authorization: string, message = 'Invalid access token') {
  const result = authenticate(authorization);
  await expect(result).rejects.toThrow(UnauthorizedException);
  await expect(result).rejects.toThrow(message);
}

describe('JwtAuthStrategy', () => {
  it('returns the user from a wallet-core access token', async () => {
    await expect(authenticate(`Bearer ${sign()}`)).resolves.toEqual({
      id: USER_ID,
      permissions: ['wallet'],
      strategy: 'jwt',
    });
  });

  it('accepts any casing of "Bearer" and de-duplicates permissions', async () => {
    const token = sign(claims({ permissions: ['bo:users', 'bo:users'] }));
    await expect(authenticate(`bearer ${token}`)).resolves.toMatchObject({
      permissions: ['bo:users'],
    });
  });

  it('accepts a user without any permissions', async () => {
    await expect(authenticate(`Bearer ${sign(claims({ permissions: [] }))}`)).resolves.toEqual({
      id: USER_ID,
      permissions: [],
      strategy: 'jwt',
    });
  });

  it('returns null without a Bearer token, so the guard answers 401', async () => {
    await expect(authenticate(undefined)).resolves.toBeNull();
    await expect(authenticate('Bearer ')).resolves.toBeNull();
    await expect(authenticate('Basic dXNlcjpwYXNz')).resolves.toBeNull();
    await expect(authenticate('Dev 1:wallet')).resolves.toBeNull();
  });

  it('rejects an expired token', async () => {
    const iat = now() - 20 * 60;
    await expectRejected(
      `Bearer ${sign(claims({ iat, exp: iat + 15 * 60 }))}`,
      'Access token expired',
    );
  });

  it('rejects garbage', async () => {
    await expectRejected('Bearer not-a-jwt');
  });

  it('rejects a token signed with another secret', async () => {
    await expectRejected(`Bearer ${sign(claims(), 'another-secret-0123456789-abcdefghijkl')}`);
  });

  it('rejects a tampered payload', async () => {
    const [header, , signature] = sign().split('.');
    const forged = base64url(claims({ permissions: ['bo:users:modify'] }));
    await expectRejected(`Bearer ${header}.${forged}.${signature}`);
  });

  it('rejects alg "none" and algorithms other than HS256', async () => {
    const none = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(claims())}.`;
    await expectRejected(`Bearer ${none}`);
    const hs512 = jwtService.sign(claims(), { secret: SECRET, algorithm: 'HS512' });
    await expectRejected(`Bearer ${hs512}`);
  });

  it('rejects another issuer', async () => {
    await expectRejected(`Bearer ${sign(claims({ iss: 'someone-else' }))}`);
  });

  it.each([
    ['without exp', { exp: undefined }],
    ['sub is not a UUID', { sub: '42' }],
    ['without sub', { sub: undefined }],
    ['permissions is not an array', { permissions: 'wallet' }],
    ['permissions contains a non-string', { permissions: ['wallet', 1] }],
    ['without permissions', { permissions: undefined }],
  ])('rejects a token %s', async (_case, overrides) => {
    await expectRejected(`Bearer ${sign(claims(overrides))}`);
  });

  describe('logging', () => {
    afterEach(() => jest.restoreAllMocks());

    it('logs why a token was rejected, but never the token itself', async () => {
      const warn = jest.spyOn(logger, 'warn');
      const token = sign(claims(), 'another-secret-0123456789-abcdefghijkl');
      await expectRejected(`Bearer ${token}`);
      expect(warn).toHaveBeenCalledWith({ reason: 'invalid signature' }, 'access token rejected');
      expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
    });

    it('logs which claims are invalid', async () => {
      const warn = jest.spyOn(logger, 'warn');
      await expectRejected(`Bearer ${sign(claims({ sub: '42' }))}`);
      expect(warn).toHaveBeenCalledWith(
        { reason: 'invalid claims', claims: ['sub'] },
        'access token rejected',
      );
    });

    it('logs an expired token at debug level only', async () => {
      const warn = jest.spyOn(logger, 'warn');
      const debug = jest.spyOn(logger, 'debug');
      const iat = now() - 20 * 60;
      await expectRejected(
        `Bearer ${sign(claims({ iat, exp: iat + 15 * 60 }))}`,
        'Access token expired',
      );
      expect(debug).toHaveBeenCalledWith(
        { expiredAt: new Date((iat + 15 * 60) * 1000) },
        'access token expired',
      );
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
