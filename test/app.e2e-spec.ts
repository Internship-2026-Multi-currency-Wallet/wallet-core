import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createApp, waitForRedis } from './create-app.js';

const gql = (app: INestApplication, query: string, authorization?: string) => {
  const req = request(app.getHttpServer() as App).post('/graphql');
  if (authorization) req.set('Authorization', authorization);
  return req.send({ query });
};

describe('wallet-core (e2e, DEV_AUTH=true)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp({ DEV_AUTH: 'true', CLIENT: 'demo' });
    await waitForRedis(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health reports service, client and dependencies', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/health')
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      appEnv: 'local',
      service: 'wallet-core',
      client: 'demo',
      db: 'UP',
      redis: 'UP',
    });
  });

  it('query health is public', async () => {
    const res = await gql(app, '{ health { service version client db redis } }').expect(200);
    expect(res.body.data.health).toMatchObject({ service: 'wallet-core', db: 'UP', redis: 'UP' });
  });

  it('query me returns the dev user', async () => {
    const res = await gql(app, '{ me { id kind permissions strategy } }', 'Dev 1:wallet').expect(
      200,
    );
    expect(res.body.data.me).toEqual({
      id: '1',
      kind: 'CLIENT',
      permissions: ['wallet'],
      strategy: 'dev',
    });
  });

  // The second header is the back-office dev user: staff permissions without a plain "bo".
  it.each(['Dev 42:bo', 'Dev 100:bo:users,bo:users:modify'])(
    'query me returns STAFF for %s',
    async (authorization) => {
      const res = await gql(app, '{ me { kind } }', authorization).expect(200);
      expect(res.body.data.me).toEqual({ kind: 'STAFF' });
    },
  );

  it('query me without credentials is UNAUTHENTICATED', async () => {
    const res = await gql(app, '{ me { id } }');
    expect(res.body.data).toBeNull();
    expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it.each([
    '{ staffSettings { key } }',
    '{ settingHistory { key } }',
    'mutation { updateSetting(key: "auth.googleLogin", value: false) { key } }',
    'mutation { resetSetting(key: "auth.googleLogin") { key } }',
  ])('settings operation without bo:settings is FORBIDDEN: %s', async (query) => {
    const res = await gql(app, query, 'Dev 7:bo:users');
    expect(res.body.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('bo:settings can read staffSettings but not modify', async () => {
    const read = await gql(app, '{ staffSettings { key } }', 'Dev 7:bo:settings');
    expect(read.body.errors).toBeUndefined();
    expect(read.body.data.staffSettings).toEqual([
      { key: 'auth.googleLogin' },
      { key: 'auth.phoneRequiredAt' },
      { key: 'products.enabled' },
    ]);
    const write = await gql(
      app,
      'mutation { updateSetting(key: "auth.googleLogin", value: false) { key } }',
      'Dev 7:bo:settings',
    );
    expect(write.body.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('HTTP endpoints use the same seams', async () => {
    const server = app.getHttpServer() as App;
    await request(server).get('/__test/whoami').expect(401);
    const me = await request(server)
      .get('/__test/whoami')
      .set('Authorization', 'Dev 7:bo:users')
      .expect(200);
    expect(me.body).toEqual({ id: '7', kind: 'staff', permissions: ['bo:users'], strategy: 'dev' });
  });

  it('@RequirePermission returns 403 without the permission and 200 with it', async () => {
    const server = app.getHttpServer() as App;
    await request(server)
      .get('/__test/modify-users')
      .set('Authorization', 'Dev 7:bo:users')
      .expect(403);
    await request(server)
      .get('/__test/modify-users')
      .set('Authorization', 'Dev 7:bo:users,bo:users:modify')
      .expect(200, { ok: true });
  });
});

describe('wallet-core (e2e, DEV_AUTH=false, no real strategy yet)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp({ DEV_AUTH: 'false', CLIENT: 'kvitka' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects dev credentials', async () => {
    const res = await gql(app, '{ me { id } }', 'Dev 1:wallet');
    expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
    await request(app.getHttpServer() as App)
      .get('/__test/whoami')
      .set('Authorization', 'Dev 1:wallet')
      .expect(401);
  });

  it('keeps public endpoints open and reports the configured client', async () => {
    const res = await gql(app, '{ health { client } }').expect(200);
    expect(res.body.data.health.client).toBe('kvitka');
  });
});
