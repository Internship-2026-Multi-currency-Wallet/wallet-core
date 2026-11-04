import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createApp } from './create-app.js';

/**
 * Staff GraphQL contract (stubs): who may call which operation. Business logic comes in later PRs,
 * so a caller who passes the guards gets the stub's "not implemented" error.
 */
describe('staff contract (e2e, DEV_AUTH=true)', () => {
  let app: INestApplication;

  interface GqlResponse {
    data: Record<string, unknown> | null;
    errors?: { message: string; extensions: { code: string } }[];
  }

  /** The first error's code, or `STUB` when the call passed the guards and reached the stub. */
  const errorCode = async (query: string, authorization?: string): Promise<string | undefined> => {
    const req = request(app.getHttpServer() as App).post('/graphql');
    if (authorization) req.set('Authorization', authorization);
    const body = (await req.send({ query })).body as GqlResponse;
    const error = body.errors?.[0];
    return error && /is not implemented yet$/.test(error.message) ? 'STUB' : error?.extensions.code;
  };

  beforeAll(async () => {
    app = await createApp({ DEV_AUTH: 'true', CLIENT: 'demo' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('staffMembers requires bo:staff', async () => {
    const query = '{ staffMembers { id email role status } }';
    expect(await errorCode(query, 'Dev 1:bo')).toBe('FORBIDDEN');
    expect(await errorCode(query, 'Dev 1:bo,bo:staff')).toBe('STUB');
  });

  const ID = '00000000-0000-4000-8000-000000000001';

  it.each([
    ['inviteStaff', `mutation { inviteStaff(input: { email: "a@b.co", role: SUPPORT }) { id } }`],
    ['resendStaffInvitation', `mutation { resendStaffInvitation(staffId: "${ID}") { id } }`],
    ['deactivateStaff', `mutation { deactivateStaff(staffId: "${ID}") { id status } }`],
    [
      'changeStaffRole',
      `mutation { changeStaffRole(staffId: "${ID}", role: FINANCE) { id role } }`,
    ],
  ])('%s requires bo:staff:modify', async (_name, query) => {
    expect(await errorCode(query)).toBe('UNAUTHENTICATED');
    expect(await errorCode(query, 'Dev 1:bo,bo:staff')).toBe('FORBIDDEN');
    expect(await errorCode(query, 'Dev 1:bo,bo:staff,bo:staff:modify')).toBe('STUB');
  });

  it.each([
    ['staffMe', '{ staffMe { id email role permissions } }'],
    [
      'changeOwnStaffPassword',
      'mutation { changeOwnStaffPassword(input: { currentPassword: "a", newPassword: "b" }) }',
    ],
  ])('%s requires the base staff permission bo', async (_name, query) => {
    expect(await errorCode(query)).toBe('UNAUTHENTICATED');
    expect(await errorCode(query, 'Dev 1:wallet')).toBe('FORBIDDEN');
    expect(await errorCode(query, 'Dev 1:bo')).toBe('STUB');
  });

  it.each([
    [
      'staffLogin',
      'mutation { staffLogin(input: { email: "a@b.co", password: "x" }) { accessToken accessTokenExpiresAt staff { id email role permissions } } }',
    ],
    ['staffRefreshSession', 'mutation { staffRefreshSession { accessToken } }'],
    ['staffLogout', 'mutation { staffLogout }'],
    [
      'acceptStaffInvitation',
      'mutation { acceptStaffInvitation(input: { token: "t", password: "x" }) }',
    ],
  ])('%s is public', async (_name, query) => {
    expect(await errorCode(query)).toBe('STUB');
  });
});
