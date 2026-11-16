import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createApp } from './create-app.js';

describe('google auth contract (e2e, DEV_AUTH=true)', () => {
  let app: INestApplication;

  interface GqlResponse {
    data: Record<string, unknown> | null;
    errors?: { message: string; extensions: { code: string } }[];
  }

  // `STUB`: the call passed the guards and reached a not-implemented stub.
  const errorCode = async (query: string, authorization?: string): Promise<string | undefined> => {
    const req = request(app.getHttpServer() as App).post('/graphql');
    if (authorization) req.set('Authorization', authorization);
    const error = ((await req.send({ query })).body as GqlResponse).errors?.[0];
    return error && /is not implemented yet$/.test(error.message) ? 'STUB' : error?.extensions.code;
  };

  const INPUT =
    '{ code: "c", state: "s", redirectUri: "http://localhost:5173/auth/google/callback" }';

  beforeAll(async () => {
    app = await createApp({ DEV_AUTH: 'true', CLIENT: 'demo' });
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['googleAccount', '{ googleAccount { email linkedAt } }'],
    ['startGoogleLink', 'mutation { startGoogleLink { state nonce expiresAt } }'],
    ['linkGoogleAccount', `mutation { linkGoogleAccount(input: ${INPUT}) { email linkedAt } }`],
    ['unlinkGoogleAccount', 'mutation { unlinkGoogleAccount }'],
  ])('%s requires a client token', async (_name, query) => {
    expect(await errorCode(query)).toBe('UNAUTHENTICATED');
    expect(await errorCode(query, 'Dev 1:bo')).toBe('FORBIDDEN');
    expect(await errorCode(query, 'Dev 1:wallet')).toBe('STUB');
  });

  it.each([
    ['startGoogleLogin', 'mutation { startGoogleLogin { state nonce expiresAt } }'],
    [
      'loginWithGoogle',
      `mutation { loginWithGoogle(input: ${INPUT}) { accessToken accessTokenExpiresAt user { id email phone } } }`,
    ],
  ])('%s is public', async (_name, query) => {
    expect(await errorCode(query)).toBe('STUB');
  });

  it('loginWithGoogle takes codeVerifier as optional, and state as required', async () => {
    const withVerifier = `mutation { loginWithGoogle(input: { code: "c", state: "s", redirectUri: "r", codeVerifier: "v" }) { accessToken } }`;
    expect(await errorCode(withVerifier)).toBe('STUB');
    const noState = `mutation { loginWithGoogle(input: { code: "c", redirectUri: "r" }) { accessToken } }`;
    expect(await errorCode(noState)).toBe('GRAPHQL_VALIDATION_FAILED');
  });
});
