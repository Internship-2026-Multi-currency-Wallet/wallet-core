import { jest } from '@jest/globals';
import type { OAuth2Client } from 'google-auth-library';
import { InvalidGoogleCodeError } from './google-identity.js';
import { GoogleOAuthVerifier } from './google-oauth.verifier.js';

const CLIENT_ID = '123-abc.apps.googleusercontent.com';
const CODE = {
  code: '4/0Ab-code',
  redirectUri: 'http://localhost:5173/auth/google/callback',
  codeVerifier: 'verifier',
};

interface FakeOptions {
  getToken?: () => Promise<unknown>;
  certs?: () => Promise<unknown>;
  payload?: Record<string, unknown> | undefined;
  verifyIdToken?: () => Promise<unknown>;
}

function setup(options: FakeOptions = {}) {
  const client = {
    getToken: jest.fn(options.getToken ?? (() => Promise.resolve({ tokens: { id_token: 'jwt' } }))),
    getFederatedSignonCertsAsync: jest.fn(options.certs ?? (() => Promise.resolve({}))),
    verifyIdToken: jest.fn(
      options.verifyIdToken ??
        (() =>
          Promise.resolve({
            getPayload: () =>
              'payload' in options
                ? options.payload
                : {
                    sub: 'google-sub-1',
                    email: 'User@Gmail.com',
                    email_verified: true,
                    nonce: 'n-1',
                  },
          })),
    ),
  };
  const verifier = new GoogleOAuthVerifier(CLIENT_ID, client as unknown as OAuth2Client);
  return { verifier, client };
}

function httpError(status: number): Error {
  return Object.assign(new Error(`status ${status}`), { response: { status } });
}

describe('GoogleOAuthVerifier', () => {
  it('exchanges the code with the redirect URI and verifier, then checks the ID token for our client', async () => {
    const { verifier, client } = setup();
    await expect(verifier.verify(CODE)).resolves.toEqual({
      sub: 'google-sub-1',
      email: 'user@gmail.com',
      emailVerified: true,
      nonce: 'n-1',
    });
    expect(client.getToken).toHaveBeenCalledWith({
      code: CODE.code,
      redirect_uri: CODE.redirectUri,
      codeVerifier: CODE.codeVerifier,
    });
    expect(client.verifyIdToken).toHaveBeenCalledWith({ idToken: 'jwt', audience: CLIENT_ID });
  });

  it.each([
    ['false', false],
    ['missing', undefined],
  ])('reports email_verified %s as not verified', async (_name, emailVerified) => {
    const { verifier } = setup({
      payload: { sub: 'google-sub-1', email: 'user@gmail.com', email_verified: emailVerified },
    });
    await expect(verifier.verify(CODE)).resolves.toMatchObject({
      emailVerified: false,
      nonce: undefined,
    });
  });

  it('treats a 400 from the token endpoint as an invalid code', async () => {
    const { verifier, client } = setup({ getToken: () => Promise.reject(httpError(400)) });
    await expect(verifier.verify(CODE)).rejects.toBeInstanceOf(InvalidGoogleCodeError);
    expect(client.verifyIdToken).not.toHaveBeenCalled();
  });

  it.each([
    ['401 (wrong client secret)', httpError(401)],
    ['500', httpError(500)],
    ['a network error', new Error('ETIMEDOUT')],
  ])('lets %s from the token endpoint through', async (_name, failure) => {
    const { verifier } = setup({ getToken: () => Promise.reject(failure) });
    await expect(verifier.verify(CODE)).rejects.toBe(failure);
  });

  it('treats an answer without an ID token as an invalid code', async () => {
    const { verifier } = setup({ getToken: () => Promise.resolve({ tokens: {} }) });
    await expect(verifier.verify(CODE)).rejects.toBeInstanceOf(InvalidGoogleCodeError);
  });

  it('lets a failure to fetch Google certificates through', async () => {
    const failure = new Error('Failed to retrieve verification certificates');
    const { verifier, client } = setup({ certs: () => Promise.reject(failure) });
    await expect(verifier.verify(CODE)).rejects.toBe(failure);
    expect(client.verifyIdToken).not.toHaveBeenCalled();
  });

  it('treats a rejected ID token (signature, audience, issuer, expiry) as an invalid code', async () => {
    const { verifier } = setup({
      verifyIdToken: () => Promise.reject(new Error('Wrong recipient')),
    });
    await expect(verifier.verify(CODE)).rejects.toBeInstanceOf(InvalidGoogleCodeError);
  });

  it.each([
    ['no payload', undefined],
    ['no sub', { email: 'user@gmail.com' }],
    ['no email', { sub: 'google-sub-1' }],
  ])('treats an ID token with %s as an invalid code', async (_name, payload) => {
    const { verifier } = setup({ payload });
    await expect(verifier.verify(CODE)).rejects.toBeInstanceOf(InvalidGoogleCodeError);
  });

  it('is built with our client ID and secret', () => {
    const verifier = GoogleOAuthVerifier.create(CLIENT_ID, 'GOCSPX-test');
    expect(verifier).toBeInstanceOf(GoogleOAuthVerifier);
  });
});
