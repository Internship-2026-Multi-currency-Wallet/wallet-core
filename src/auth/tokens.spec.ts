import { JwtService } from '@nestjs/jwt';
import { AppConfig } from '../config/app-config.js';
import { accessTokenPayloadSchema } from './access-token.js';
import { TokenService, USER_PERMISSIONS, hashRefreshToken, newRefreshToken } from './tokens.js';

describe('TokenService.signAccessToken', () => {
  const config = AppConfig.fromEnv({ JWT_SECRET: 's'.repeat(32), JWT_ACCESS_TTL: '15m' });
  const jwt = new JwtService();
  const tokens = new TokenService(jwt, config);
  const NOW = new Date('2026-11-04T10:00:00.400Z');
  const USER_ID = '0b6f3c2e-8d4a-4f7e-9c1b-2a5d6e7f8a9b';

  const client = { userId: USER_ID, aud: 'wallet', permissions: USER_PERMISSIONS } as const;
  const verified = (token: string): unknown =>
    jwt.verify(token, {
      secret: 's'.repeat(32),
      algorithms: ['HS256'],
      issuer: 'wallet-core',
      ignoreExpiration: true,
    });

  it('issues the HS256 token rates-service and treasury-service accept', () => {
    const { token, expiresAt } = tokens.signAccessToken(client, NOW);

    const iat = Date.parse('2026-11-04T10:00:00.000Z') / 1000;
    expect(accessTokenPayloadSchema.parse(verified(token))).toEqual({
      sub: USER_ID,
      aud: 'wallet',
      permissions: ['wallet'],
      iss: 'wallet-core',
      iat,
      exp: iat + 900,
    });
    expect(expiresAt).toEqual(new Date('2026-11-04T10:15:00.000Z'));
  });

  it('issues a staff token with the audience and permissions it is given', () => {
    const { token } = tokens.signAccessToken(
      { userId: USER_ID, aud: 'backoffice', permissions: ['bo', 'bo:settings'] },
      NOW,
    );
    expect(accessTokenPayloadSchema.parse(verified(token))).toMatchObject({
      aud: 'backoffice',
      permissions: ['bo', 'bo:settings'],
    });
  });

  it('cannot be verified with another secret', () => {
    const { token } = tokens.signAccessToken(client, new Date());
    expect(() => {
      jwt.verify(token, { secret: 'o'.repeat(32), algorithms: ['HS256'] });
    }).toThrow('invalid signature');
  });
});

describe('newRefreshToken', () => {
  it('returns a random 256-bit token and its SHA-256 hex', () => {
    const first = newRefreshToken();
    const second = newRefreshToken();

    expect(first.token).toMatch(/^[\w-]{43}$/);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.hash).toBe(hashRefreshToken(first.token));
    expect(first.hash).not.toContain(first.token);
    expect(second.token).not.toBe(first.token);
  });
});
