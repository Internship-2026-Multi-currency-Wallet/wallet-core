import type { INestApplication } from '@nestjs/common';
import type { Knex } from 'knex';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createKnex } from '../src/database/database.module.js';
import { createApp } from './create-app.js';

/**
 * Staff GraphQL contract: who may call which operation. Staff management operations are implemented
 * and reach the service once the guards pass; `staffLogin` and `staffLogout` are implemented; `changeOwnStaffPassword` and the other public staff auth
 * mutations are still stubs and answer "not implemented" (`STUB`).
 */
describe('staff contract (e2e, DEV_AUTH=true)', () => {
  let app: INestApplication;
  let db: Knex;

  interface GqlResponse {
    data: Record<string, unknown> | null;
    errors?: { message: string; extensions: { code: string } }[];
  }

  const call = async (query: string, authorization?: string): Promise<GqlResponse> => {
    const req = request(app.getHttpServer() as App).post('/graphql');
    if (authorization) req.set('Authorization', authorization);
    return (await req.send({ query })).body as GqlResponse;
  };

  /** The first error's code, or `STUB` when the call passed the guards and reached a stub. */
  const errorCode = async (query: string, authorization?: string): Promise<string | undefined> => {
    const error = (await call(query, authorization)).errors?.[0];
    return error && /is not implemented yet$/.test(error.message) ? 'STUB' : error?.extensions.code;
  };

  beforeAll(async () => {
    app = await createApp({ DEV_AUTH: 'true', CLIENT: 'demo' });
    db = createKnex(process.env.DATABASE_URL!);
  });

  beforeEach(async () => {
    // DELETE, not TRUNCATE: MySQL refuses to truncate a table referenced by a foreign key.
    await db('staff_sessions').delete();
    await db('staff_invitations').delete();
    await db('staff').delete();
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('staffMembers requires bo:staff', async () => {
    const query = '{ staffMembers { id email role status } }';
    expect(await errorCode(query)).toBe('UNAUTHENTICATED');
    expect(await errorCode(query, 'Dev 1:bo')).toBe('FORBIDDEN');
    expect(await errorCode(query, 'Dev 1:bo,bo:staff')).toBeUndefined();
  });

  const ID = '00000000-0000-4000-8000-000000000001';

  it('inviteStaff requires bo:staff:modify and creates an INVITED member', async () => {
    const query = `mutation { inviteStaff(input: { email: "a@b.co", role: SUPPORT }) { id status } }`;
    expect(await errorCode(query)).toBe('UNAUTHENTICATED');
    expect(await errorCode(query, 'Dev 1:bo,bo:staff')).toBe('FORBIDDEN');
    const body = await call(query, 'Dev 1:bo,bo:staff,bo:staff:modify');
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({
      inviteStaff: { id: expect.any(String), status: 'INVITED' },
    });
  });

  it.each([
    ['resendStaffInvitation', `mutation { resendStaffInvitation(staffId: "${ID}") { id } }`],
    ['deactivateStaff', `mutation { deactivateStaff(staffId: "${ID}") { id status } }`],
    [
      'changeStaffRole',
      `mutation { changeStaffRole(staffId: "${ID}", role: FINANCE) { id role } }`,
    ],
  ])('%s requires bo:staff:modify', async (_name, query) => {
    expect(await errorCode(query)).toBe('UNAUTHENTICATED');
    expect(await errorCode(query, 'Dev 1:bo,bo:staff')).toBe('FORBIDDEN');
    expect(await errorCode(query, 'Dev 1:bo,bo:staff,bo:staff:modify')).toBe('STAFF_NOT_FOUND');
  });

  it.each([
    ['staffMe', '{ staffMe { id email role permissions } }', 'STAFF_NOT_FOUND'],
    [
      'changeOwnStaffPassword',
      'mutation { changeOwnStaffPassword(input: { currentPassword: "a", newPassword: "b" }) }',
      'STUB',
    ],
  ])('%s requires the base staff permission bo', async (_name, query, passesGuardsWith) => {
    expect(await errorCode(query)).toBe('UNAUTHENTICATED');
    expect(await errorCode(query, 'Dev 1:wallet')).toBe('FORBIDDEN');
    expect(await errorCode(query, 'Dev 1:bo')).toBe(passesGuardsWith);
  });

  it.each([
    [
      'staffLogin',
      'mutation { staffLogin(input: { email: "a@b.co", password: "x" }) { accessToken accessTokenExpiresAt staff { id email role permissions } } }',
      'INVALID_CREDENTIALS',
    ],
    [
      'staffRefreshSession',
      'mutation { staffRefreshSession { accessToken } }',
      'INVALID_REFRESH_TOKEN',
    ],
    ['staffLogout', 'mutation { staffLogout }', undefined],
  ])('%s is public', async (_name, query, expected) => {
    expect(await errorCode(query)).toBe(expected);
  });

  it('acceptStaffInvitation is public', async () => {
    const query = 'mutation { acceptStaffInvitation(input: { token: "t", password: "x" }) }';
    expect(await errorCode(query)).toBe('BAD_USER_INPUT');
  });
});
