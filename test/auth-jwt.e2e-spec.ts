import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Knex } from 'knex';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { LOCAL_JWT_SECRET } from '../src/config/env.schema.js';
import { createKnex } from '../src/database/database.module.js';
import { createApp } from './create-app.js';

/** Real authentication end to end, without dev auth. Needs migrations applied. */
describe('access token (e2e, DEV_AUTH=false)', () => {
  const PASSWORD = 'Qwerty1!';
  let app: INestApplication;
  let db: Knex;
  let userId: string;
  let accessToken: string;

  interface GqlBody {
    data: Record<string, { id: string; accessToken: string } | null> | null;
    errors?: { extensions: { code: string } }[];
  }

  const gql = async (query: string, authorization?: string): Promise<GqlBody> => {
    const req = request(app.getHttpServer() as App).post('/graphql');
    if (authorization) req.set('Authorization', authorization);
    return (await req.send({ query })).body as GqlBody;
  };
  const me = (authorization?: string) => gql('{ me { id permissions strategy } }', authorization);

  beforeAll(async () => {
    app = await createApp({ DEV_AUTH: 'false' });
    db = createKnex(process.env.DATABASE_URL!);
    await db('sessions').delete();
    await db('users').delete();
    // Another spec may leave auth.phoneRequiredAt = signup behind.
    await db('client_setting_changes').delete();
    await db('client_settings').delete();

    const registered = await gql(
      `mutation { register(input: { email: "artem@test.com", password: "${PASSWORD}" }) { id } }`,
    );
    userId = registered.data!.register!.id;
    const loggedIn = await gql(
      `mutation { login(input: { email: "artem@test.com", password: "${PASSWORD}" }) { accessToken } }`,
    );
    accessToken = loggedIn.data!.login!.accessToken;
  });

  afterAll(async () => {
    await db.destroy();
    await app.close();
  });

  it('authenticates a request with the access token from login', async () => {
    await expect(me(`Bearer ${accessToken}`)).resolves.toEqual({
      data: { me: { id: userId, permissions: ['wallet'], strategy: 'jwt' } },
    });
  });

  // The table is built before beforeAll runs, so the header is a function.
  it.each([
    ['no token', () => undefined],
    ['a dev header', () => 'Dev 1:wallet'],
    ['a tampered token', () => `Bearer ${accessToken}x`],
  ])('is UNAUTHENTICATED with %s', async (_case, authorization) => {
    const body = await me(authorization());
    expect(body.errors?.[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('is UNAUTHENTICATED with an expired token', async () => {
    const iat = Math.floor(Date.now() / 1000) - 20 * 60;
    const expired = new JwtService().sign(
      { sub: userId, permissions: ['wallet'], iss: 'wallet-core', iat, exp: iat + 15 * 60 },
      { secret: LOCAL_JWT_SECRET, algorithm: 'HS256' },
    );
    const body = await me(`Bearer ${expired}`);
    expect(body.errors?.[0].extensions.code).toBe('UNAUTHENTICATED');
  });
});
