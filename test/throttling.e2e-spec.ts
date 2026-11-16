import { randomInt, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { REDIS } from '../src/redis/redis.module.js';
import { createApp, waitForRedis } from './create-app.js';

const LIMITS = {
  THROTTLE_LIMIT_ANONYMOUS: '3',
  THROTTLE_LIMIT_USER: '5',
  THROTTLE_TTL_SECONDS: '2',
};
const ANONYMOUS_QUERY = '{ publicSettings { key } }';
const USER_QUERY = '{ me { id } }';

interface GqlBody {
  data: unknown;
  errors?: { extensions: Record<string, unknown> }[];
}

// Counters live in the real Redis and all specs call from 127.0.0.1, so each test sets its own X-Forwarded-For IP and user ids.
const randomIp = (): string => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;
const devAuth = (id: string, permissions: string) => ({
  Authorization: `Dev ${id}:${permissions}`,
});
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const gqlOn = (app: INestApplication, query: string, headers: Record<string, string>) =>
  request(app.getHttpServer() as App)
    .post('/graphql')
    .set(headers)
    .send({ query });
const codeOf = (body: unknown): unknown => (body as GqlBody).errors?.[0]?.extensions.code;

describe('global rate limit (e2e)', () => {
  let app: INestApplication;

  const gql = (query: string, headers: Record<string, string>) => gqlOn(app, query, headers);
  const anonymous = (ip: string) => gql(ANONYMOUS_QUERY, { 'X-Forwarded-For': ip });
  const asUser = (ip: string, auth: Record<string, string>) =>
    gql(USER_QUERY, { 'X-Forwarded-For': ip, ...auth });
  const whoami = (auth: Record<string, string>) =>
    request(app.getHttpServer() as App)
      .get('/__test/whoami')
      .set({ 'X-Forwarded-For': randomIp(), ...auth });

  beforeAll(async () => {
    app = await createApp(LIMITS);
    await waitForRedis(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('counts anonymous requests per client IP', async () => {
    const ipA = randomIp();
    const ipB = randomIp();

    for (let i = 0; i < 3; i++) {
      expect(codeOf((await anonymous(ipA)).body)).toBeUndefined();
    }
    const refused = await anonymous(ipA);
    const other = await anonymous(ipB);

    expect(codeOf(refused.body)).toBe('TOO_MANY_REQUESTS');
    expect(codeOf(other.body)).toBeUndefined();
  });

  it('counts the last X-Forwarded-For entry, so a spoofed first entry does not help', async () => {
    const proxyAddedIp = randomIp();

    for (let i = 0; i < 3; i++) {
      const res = await anonymous(`${randomIp()}, ${proxyAddedIp}`);
      expect(codeOf(res.body)).toBeUndefined();
    }
    const fourth = await anonymous(`${randomIp()}, ${proxyAddedIp}`);

    expect(codeOf(fourth.body)).toBe('TOO_MANY_REQUESTS');
  });

  it('counts authenticated requests per user with the user limit', async () => {
    const ip = randomIp();
    const user1 = devAuth(randomUUID(), 'wallet');
    const user2 = devAuth(randomUUID(), 'wallet');

    // 5 passes (not 3) prove the guard runs after AuthGuard and picks the user limit.
    for (let i = 0; i < 5; i++) {
      expect(codeOf((await asUser(ip, user1)).body)).toBeUndefined();
    }
    const refused = await asUser(ip, user1);
    const otherUser = await asUser(ip, user2);

    expect(codeOf(refused.body)).toBe('TOO_MANY_REQUESTS');
    expect(codeOf(otherUser.body)).toBeUndefined();
  });

  it('keeps a user and a staff member with the same id in separate counters', async () => {
    const ip = randomIp();
    const id = randomUUID();

    for (let i = 0; i < 5; i++) {
      await asUser(ip, devAuth(id, 'wallet'));
    }
    const userRefused = await asUser(ip, devAuth(id, 'wallet'));
    const staff = await asUser(ip, devAuth(id, 'bo'));

    expect(codeOf(userRefused.body)).toBe('TOO_MANY_REQUESTS');
    expect(codeOf(staff.body)).toBeUndefined();
  });

  it('answers a GraphQL refusal with the TOO_MANY_REQUESTS code and retryAfterSeconds', async () => {
    const ip = randomIp();
    for (let i = 0; i < 3; i++) await anonymous(ip);

    const refused = await anonymous(ip);

    const extensions = (refused.body as GqlBody).errors?.[0].extensions;
    expect(extensions).toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      retryAfterSeconds: expect.any(Number),
    });
    expect([1, 2]).toContain(extensions?.retryAfterSeconds);
  });

  it('answers a REST refusal with 429 and a Retry-After header', async () => {
    const auth = devAuth(randomUUID(), 'wallet');
    for (let i = 0; i < 5; i++) await whoami(auth).expect(200);

    const refused = await whoami(auth).expect(429);

    expect([1, 2]).toContain(Number(refused.headers['retry-after']));
  });

  it('refuses until the window ends and not longer', async () => {
    const ip = randomIp();
    for (let i = 0; i < 3; i++) await anonymous(ip);
    const refused = await anonymous(ip);
    expect(codeOf(refused.body)).toBe('TOO_MANY_REQUESTS');
    const retryAfterSeconds = (refused.body as GqlBody).errors?.[0].extensions
      .retryAfterSeconds as number;

    await sleep(retryAfterSeconds * 1000 + 100);

    expect(codeOf((await anonymous(ip)).body)).toBeUndefined();
  });

  it('never limits /health', async () => {
    const ip = randomIp();

    for (let i = 0; i < 10; i++) {
      for (const path of ['/health', '/health/']) {
        const res = await request(app.getHttpServer() as App)
          .get(path)
          .set('X-Forwarded-For', ip);
        expect(res.status).not.toBe(429);
      }
    }
  });

  it('counts one HTTP request once, however many top-level fields it has', async () => {
    const ip = randomIp();
    const twoFields = '{ publicSettings { key } health { service } }';

    for (let i = 0; i < 3; i++) {
      const res = await gql(twoFields, { 'X-Forwarded-For': ip });
      expect(codeOf(res.body)).toBeUndefined();
    }
    const fourth = await gql(twoFields, { 'X-Forwarded-For': ip });

    expect(codeOf(fourth.body)).toBe('TOO_MANY_REQUESTS');
  });
});

describe('global rate limit when Redis is unavailable (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp(LIMITS);
  });

  afterAll(async () => {
    await app.close();
  });

  it('lets requests through instead of failing them', async () => {
    const ip = randomIp();
    app.get<Redis>(REDIS).disconnect();

    for (let i = 0; i < 5; i++) {
      const res = await gqlOn(app, ANONYMOUS_QUERY, { 'X-Forwarded-For': ip });
      expect((res.body as GqlBody).errors).toBeUndefined();
    }
  });
});
