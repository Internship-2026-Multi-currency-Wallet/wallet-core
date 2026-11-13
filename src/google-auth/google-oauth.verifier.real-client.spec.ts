import { generateKeyPairSync } from 'node:crypto';
import { jest } from '@jest/globals';
import { JwtService } from '@nestjs/jwt';
import { OAuth2Client } from 'google-auth-library';
import { InvalidGoogleCodeError } from './google-identity.js';
import { GoogleOAuthVerifier } from './google-oauth.verifier.js';

const CLIENT_ID = '123-abc.apps.googleusercontent.com';
const KID = 'test-key';
const CODE = { code: '4/0Ab-code', redirectUri: 'http://localhost:5173/auth/google/callback' };

const googleKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = (key: typeof googleKey.privateKey) =>
  key.export({ type: 'pkcs8', format: 'pem' }).toString();

const now = () => Math.floor(Date.now() / 1000);

function idToken(
  claims: Record<string, unknown> = {},
  signingKey: typeof googleKey.privateKey = googleKey.privateKey,
): string {
  return new JwtService().sign(
    {
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      sub: 'google-sub-1',
      email: 'user@gmail.com',
      email_verified: true,
      nonce: 'n-1',
      iat: now(),
      exp: now() + 3600,
      ...claims,
    },
    { privateKey: pem(signingKey), algorithm: 'RS256', keyid: KID },
  );
}

function verifierAnswering(token: string): GoogleOAuthVerifier {
  const client = new OAuth2Client({ clientId: CLIENT_ID, clientSecret: 'GOCSPX-test' });
  jest
    .spyOn(client, 'getToken')
    .mockImplementation((() => Promise.resolve({ tokens: { id_token: token } })) as never);
  jest.spyOn(client, 'getFederatedSignonCertsAsync').mockImplementation((() =>
    Promise.resolve({
      certs: { [KID]: googleKey.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      format: 'PEM',
    })) as never);
  return new GoogleOAuthVerifier(CLIENT_ID, client);
}

describe('GoogleOAuthVerifier with the real OAuth2Client', () => {
  it("accepts Google's token for our client", async () => {
    await expect(verifierAnswering(idToken()).verify(CODE)).resolves.toEqual({
      sub: 'google-sub-1',
      email: 'user@gmail.com',
      emailVerified: true,
      nonce: 'n-1',
    });
  });

  it.each([
    ['issued for another application (aud)', idToken({ aud: 'other.apps.googleusercontent.com' })],
    ['issued by somebody else (iss)', idToken({ iss: 'https://evil.example' })],
    ['expired (exp)', idToken({ iat: now() - 7200, exp: now() - 3600 })],
    ['not signed by Google', idToken({}, otherKey.privateKey)],
    ['tampered with', tamper(idToken())],
    ['malformed', 'not-a-jwt'],
  ])('rejects a token %s', async (_name, token) => {
    await expect(verifierAnswering(token).verify(CODE)).rejects.toBeInstanceOf(
      InvalidGoogleCodeError,
    );
  });
});

function tamper(token: string): string {
  const [header, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
    string,
    unknown
  >;
  const forged = Buffer.from(JSON.stringify({ ...claims, sub: 'victim-sub' })).toString(
    'base64url',
  );
  return `${header}.${forged}.${signature}`;
}
