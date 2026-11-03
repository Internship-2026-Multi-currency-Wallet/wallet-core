import type { INestApplication } from '@nestjs/common';
import type { Knex } from 'knex';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createKnex } from '../src/database/database.module.js';
import { createApp } from './create-app.js';

/**
 * Client settings through the GraphQL API against real MySQL.
 * Needs migrations applied (`npm run migrate`); empties both settings tables before each test.
 */
describe('client settings (e2e)', () => {
  const STAFF = 'Dev 42:bo:settings,bo:settings:modify';
  let app: INestApplication;
  let db: Knex;

  interface GqlResponse {
    data: Record<string, unknown> | null;
    errors?: { message: string; extensions: { code: string } }[];
  }

  const gql = async (query: string, authorization?: string): Promise<GqlResponse> => {
    const req = request(app.getHttpServer() as App).post('/graphql');
    if (authorization) req.set('Authorization', authorization);
    return (await req.send({ query })).body as GqlResponse;
  };
  const publicSettings = async () =>
    (await gql('{ publicSettings { key value } }')).data?.publicSettings;
  const update = (key: string, value: string) =>
    gql(
      `mutation { updateSetting(key: "${key}", value: ${value}) { key value overridden } }`,
      STAFF,
    );
  const reset = (key: string) =>
    gql(`mutation { resetSetting(key: "${key}") { key value overridden } }`, STAFF);
  const history = async (args = '') =>
    (await gql(`{ settingHistory${args} { id key oldValue newValue changedBy changedAt } }`, STAFF))
      .data?.settingHistory as {
      id: string;
      oldValue: unknown;
      newValue: unknown;
      changedAt: string;
    }[];
  /** Keeps change timestamps (millisecond precision) distinct for the `before` cursor. */
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  const DEFAULTS = [
    { key: 'auth.googleLogin', value: true },
    { key: 'auth.phoneRequiredAt', value: 'never' },
    { key: 'products.enabled', value: ['wallet'] },
  ];

  beforeAll(async () => {
    app = await createApp({ DEV_AUTH: 'true', CLIENT: 'demo' });
    db = createKnex(process.env.DATABASE_URL!);
  });

  beforeEach(async () => {
    await db('client_setting_changes').truncate();
    await db('client_settings').truncate();
  });

  afterAll(async () => {
    await db.destroy();
    await app.close();
  });

  it('publicSettings returns the catalog defaults to anonymous callers', async () => {
    await expect(publicSettings()).resolves.toEqual(DEFAULTS);
  });

  it('an update applies immediately for client apps and staff', async () => {
    const res = await update('auth.phoneRequiredAt', '"signup"');
    expect(res).toEqual({
      data: { updateSetting: { key: 'auth.phoneRequiredAt', value: 'signup', overridden: true } },
    });
    await expect(publicSettings()).resolves.toContainEqual({
      key: 'auth.phoneRequiredAt',
      value: 'signup',
    });
    const staff = await gql('{ staffSettings { key value defaultValue overridden } }', STAFF);
    expect(staff.data?.staffSettings).toContainEqual({
      key: 'auth.phoneRequiredAt',
      value: 'signup',
      defaultValue: 'never',
      overridden: true,
    });
  });

  it('JSON values keep their type: boolean and list', async () => {
    await update('auth.googleLogin', 'false');
    await update('products.enabled', '["wallet", "cards"]');
    await expect(publicSettings()).resolves.toEqual([
      { key: 'auth.googleLogin', value: false },
      { key: 'auth.phoneRequiredAt', value: 'never' },
      { key: 'products.enabled', value: ['wallet', 'cards'] },
    ]);
  });

  it('rejects an invalid value with INVALID_VALUE and keeps the current value', async () => {
    const res = await update('auth.phoneRequiredAt', '"sometimes"');
    expect(res.data).toBeNull();
    expect(res.errors?.[0].extensions.code).toBe('INVALID_VALUE');
    expect(res.errors?.[0].message).toMatch(/^Invalid value for "auth.phoneRequiredAt": /);
    await expect(publicSettings()).resolves.toEqual(DEFAULTS);
    await expect(history()).resolves.toEqual([]);
  });

  it('rejects an unknown key with UNKNOWN_KEY', async () => {
    const res = await update('nope.nothing', 'true');
    expect(res.errors?.[0].extensions.code).toBe('UNKNOWN_KEY');
  });

  it('a reset brings the default back', async () => {
    await update('auth.googleLogin', 'false');
    await expect(reset('auth.googleLogin')).resolves.toEqual({
      data: { resetSetting: { key: 'auth.googleLogin', value: true, overridden: false } },
    });
    await expect(publicSettings()).resolves.toEqual(DEFAULTS);
  });

  it('records every change: old → new, and a reset as old → default', async () => {
    await update('auth.phoneRequiredAt', '"signup"');
    await tick();
    await reset('auth.phoneRequiredAt');
    const rows = await history('(key: "auth.phoneRequiredAt")');
    expect(rows).toEqual([
      expect.objectContaining({
        key: 'auth.phoneRequiredAt',
        oldValue: 'signup',
        newValue: 'never',
        changedBy: '42',
      }),
      expect.objectContaining({ oldValue: 'never', newValue: 'signup', changedBy: '42' }),
    ]);
    expect(Date.parse(rows[0].changedAt)).toBeGreaterThan(Date.parse(rows[1].changedAt));
  });

  it('pages history with `before` and `limit`', async () => {
    for (const value of ['"signup"', '"firstTransfer"', '"never"']) {
      await update('auth.phoneRequiredAt', value);
      await tick();
    }
    const [newest, ...older] = await history('(limit: 1)');
    expect(older).toEqual([]);
    expect(newest.newValue).toBe('never');

    const page2 = await history(`(before: "${newest.changedAt}", limit: 10)`);
    expect(page2.map((row) => row.newValue)).toEqual(['firstTransfer', 'signup']);

    const invalid = await gql('{ settingHistory(limit: 201) { key } }', STAFF);
    expect(invalid.errors?.[0].extensions.code).toBe('INVALID_VALUE');
  });

  it('pages through changes with the same changedAt using before + beforeId', async () => {
    await update('auth.phoneRequiredAt', '"signup"');
    await update('auth.phoneRequiredAt', '"firstTransfer"');
    // Force a tie: both rows in the same millisecond.
    await db('client_setting_changes').update({ changed_at: new Date('2026-11-02T10:00:00.000Z') });

    const [first, ...rest] = await history('(limit: 1)');
    expect(rest).toEqual([]);
    const page2 = await history(
      `(before: "${first.changedAt}", beforeId: "${first.id}", limit: 1)`,
    );
    expect(page2).toHaveLength(1);
    expect(page2[0].id).not.toBe(first.id);
    expect([first.newValue, page2[0].newValue].sort()).toEqual(['firstTransfer', 'signup']);
    const page3 = await history(
      `(before: "${page2[0].changedAt}", beforeId: "${page2[0].id}", limit: 1)`,
    );
    expect(page3).toEqual([]);
  });

  it('staff reads need bo:settings and writes need bo:settings:modify', async () => {
    const anonymous = await gql('{ staffSettings { key } }');
    expect(anonymous.errors?.[0].extensions.code).toBe('UNAUTHENTICATED');
    const readOnly = await gql(
      'mutation { resetSetting(key: "auth.googleLogin") { key } }',
      'Dev 7:bo:settings',
    );
    expect(readOnly.errors?.[0].extensions.code).toBe('FORBIDDEN');
  });
});
