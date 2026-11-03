import type { INestApplication } from '@nestjs/common';
import { verify } from '@node-rs/argon2';
import type { Knex } from 'knex';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createKnex } from '../../src/database/database.module.js';
import { createApp } from '../create-app.js';

/**
 * `register` through the GraphQL API against real MySQL.
 * Needs migrations applied (`npm run migrate`); empties users and settings before each test.
 */
describe('register (e2e)', () => {
  const STAFF = 'Dev 42:bo:settings,bo:settings:modify';
  const PASSWORD = 'Qwerty1!';
  let app: INestApplication;
  let db: Knex;

  interface GqlResponse {
    data: { register: { id: string; email: string; phone: string | null } } | null;
    errors?: { message: string; extensions: Record<string, unknown> }[];
  }

  const gql = async (
    query: string,
    variables: Record<string, unknown> = {},
    authorization?: string,
  ): Promise<GqlResponse> => {
    const req = request(app.getHttpServer() as App).post('/graphql');
    if (authorization) req.set('Authorization', authorization);
    return (await req.send({ query, variables })).body as GqlResponse;
  };
  const register = (input: Record<string, unknown>) =>
    gql(
      'mutation Register($input: RegisterInput!) { register(input: $input) { id email phone } }',
      {
        input,
      },
    );
  const users = () => db('users').select('id', 'email', 'password_hash', 'phone');

  beforeAll(async () => {
    app = await createApp({ DEV_AUTH: 'true', CLIENT: 'demo' });
    db = createKnex(process.env.DATABASE_URL!);
  });

  beforeEach(async () => {
    await db('sessions').delete();
    await db('users').delete();
    await db('client_setting_changes').delete();
    await db('client_settings').delete();
  });

  afterAll(async () => {
    await db.destroy();
    await app.close();
  });

  it('creates an account without credentials and stores only a hash of the password', async () => {
    const res = await register({ email: '  Artem@Test.com ', password: PASSWORD });

    expect(res.errors).toBeUndefined();
    expect(res.data?.register).toEqual({
      id: expect.any(String),
      email: 'artem@test.com',
      phone: null,
    });
    const [row] = await users();
    expect(row).toMatchObject({ id: res.data?.register.id, email: 'artem@test.com', phone: null });
    expect(row.password_hash).not.toContain(PASSWORD);
    await expect(verify(row.password_hash as string, PASSWORD)).resolves.toBe(true);
  });

  it('answers INVALID_CREDENTIALS for an email that is already registered', async () => {
    await register({ email: 'artem@test.com', password: PASSWORD });
    const res = await register({ email: 'ARTEM@test.com', password: 'Another1!' });

    expect(res.data).toBeNull();
    expect(res.errors?.[0]).toMatchObject({
      message: 'Invalid email or password',
      extensions: { code: 'INVALID_CREDENTIALS' },
    });
    await expect(users()).resolves.toHaveLength(1);
  });

  it('answers BAD_USER_INPUT with the field of the first broken rule', async () => {
    const res = await register({ email: 'artem@test.com', password: 'qwerty1!' });

    expect(res.errors?.[0]).toMatchObject({
      message: 'Password must contain at least one uppercase letter',
      extensions: { code: 'BAD_USER_INPUT', field: 'password' },
    });
    await expect(users()).resolves.toHaveLength(0);
  });

  it('refuses unknown input fields before the resolver runs', async () => {
    const res = await register({ email: 'artem@test.com', password: PASSWORD, role: 'admin' });

    expect(res.errors?.[0].extensions.code).toBe('BAD_USER_INPUT');
    expect(res.errors?.[0].message).toContain('"role" is not defined by type "RegisterInput"');
    await expect(users()).resolves.toHaveLength(0);
  });

  it('requires a phone when the client asks for it at signup', async () => {
    const setting = await gql(
      'mutation { updateSetting(key: "auth.phoneRequiredAt", value: "signup") { key } }',
      {},
      STAFF,
    );
    expect(setting.errors).toBeUndefined();

    const withoutPhone = await register({ email: 'artem@test.com', password: PASSWORD });
    expect(withoutPhone.errors?.[0]).toMatchObject({
      message: 'Phone is required',
      extensions: { code: 'BAD_USER_INPUT', field: 'phone' },
    });

    const withPhone = await register({
      email: 'artem@test.com',
      password: PASSWORD,
      phone: '+380501234567',
    });
    expect(withPhone.data?.register.phone).toBe('+380501234567');
  });
});
