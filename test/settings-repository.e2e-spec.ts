import type { Knex } from 'knex';
import { createKnex } from '../src/database/database.module.js';
import { SettingsRepository } from '../src/settings/settings.repository.js';

/** Needs MySQL with migrations applied (`npm run infra:up && npm run migrate`). */
describe('SettingsRepository (e2e, real MySQL)', () => {
  let db: Knex;
  let repo: SettingsRepository;

  const at = (iso: string) => new Date(iso);
  const update = (key: string, value: unknown, fallback: unknown, when: string, by = '7') =>
    repo.applyChange({ key, next: { value }, fallback, changedBy: by, at: at(when) });
  const reset = (key: string, fallback: unknown, when: string, by = '7') =>
    repo.applyChange({ key, next: null, fallback, changedBy: by, at: at(when) });

  beforeAll(() => {
    db = createKnex(process.env.DATABASE_URL!);
    repo = new SettingsRepository(db);
  });

  beforeEach(async () => {
    await db('client_setting_changes').truncate();
    await db('client_settings').truncate();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('has no overrides on an empty database', async () => {
    await expect(repo.findAll()).resolves.toEqual([]);
    await expect(repo.find('auth.googleLogin')).resolves.toBeUndefined();
  });

  it.each([
    ['boolean', 'auth.googleLogin', false, true],
    ['string', 'auth.phoneRequiredAt', 'signup', 'never'],
    ['array', 'products.enabled', ['wallet', 'cards'], ['wallet']],
  ])('round-trips a %s value as JSON', async (_kind, key, value, fallback) => {
    await expect(update(key, value, fallback, '2026-11-02T10:00:00.123Z')).resolves.toEqual({
      oldValue: fallback,
      newValue: value,
    });
    await expect(repo.find(key)).resolves.toEqual({ key, value });
    await expect(repo.findAll()).resolves.toEqual([{ key, value }]);
  });

  it('records the previous override as the old value', async () => {
    await update('auth.phoneRequiredAt', 'signup', 'never', '2026-11-02T10:00:00.000Z');
    await expect(
      update('auth.phoneRequiredAt', 'firstTransfer', 'never', '2026-11-02T10:01:00.000Z'),
    ).resolves.toEqual({ oldValue: 'signup', newValue: 'firstTransfer' });
  });

  it('reset deletes the override and records old → default', async () => {
    await update('auth.googleLogin', false, true, '2026-11-02T10:00:00.000Z');
    await expect(reset('auth.googleLogin', true, '2026-11-02T10:01:00.000Z', '9')).resolves.toEqual(
      { oldValue: false, newValue: true },
    );
    await expect(repo.find('auth.googleLogin')).resolves.toBeUndefined();
    const [latest] = await repo.history({ limit: 1 });
    expect(latest).toEqual({
      id: expect.any(String),
      key: 'auth.googleLogin',
      oldValue: false,
      newValue: true,
      changedBy: '9',
      changedAt: at('2026-11-02T10:01:00.000Z'),
    });
  });

  it('reset without an override changes nothing and records nothing', async () => {
    await expect(reset('auth.googleLogin', true, '2026-11-02T10:00:00.000Z')).resolves.toBeNull();
    await expect(repo.history({ limit: 10 })).resolves.toEqual([]);
  });

  it('writes the override and its history row in one transaction', async () => {
    await expect(
      repo.applyChange({
        key: 'auth.googleLogin',
        next: { value: false },
        fallback: true,
        changedBy: 'x'.repeat(65), // too long for changed_by → the history insert fails
        at: at('2026-11-02T10:00:00.000Z'),
      }),
    ).rejects.toThrow();
    await expect(repo.find('auth.googleLogin')).resolves.toBeUndefined();
  });

  it('serializes concurrent changes of one key, so history chains old → new', async () => {
    await update('products.enabled', ['a'], ['wallet'], '2026-11-02T10:00:00.000Z');
    const results = await Promise.all(
      ['b', 'c', 'd'].map((v, i) =>
        update('products.enabled', [v], ['wallet'], `2026-11-02T10:0${i + 1}:00.000Z`),
      ),
    );
    const olds = results.map((r) => JSON.stringify(r?.oldValue)).sort();
    const news = results.map((r) => JSON.stringify(r?.newValue));
    // Every change saw exactly one predecessor; no two saw the same one.
    expect(new Set(olds).size).toBe(3);
    for (const old of olds) expect([JSON.stringify(['a']), ...news]).toContain(old);
  });

  describe('history', () => {
    beforeEach(async () => {
      await update('auth.googleLogin', false, true, '2026-11-02T10:00:00.000Z', '1');
      await update('auth.phoneRequiredAt', 'signup', 'never', '2026-11-02T10:01:00.000Z', '2');
      await reset('auth.googleLogin', true, '2026-11-02T10:02:00.000Z', '3');
    });

    it('returns changes newest first', async () => {
      const rows = await repo.history({ limit: 10 });
      expect(rows.map((r) => r.changedBy)).toEqual(['3', '2', '1']);
      expect(rows[0].changedAt).toEqual(at('2026-11-02T10:02:00.000Z'));
    });

    it('filters by key', async () => {
      const rows = await repo.history({ key: 'auth.googleLogin', limit: 10 });
      expect(rows.map((r) => [r.oldValue, r.newValue])).toEqual([
        [false, true],
        [true, false],
      ]);
    });

    it('returns only changes strictly older than `before`', async () => {
      const rows = await repo.history({ before: at('2026-11-02T10:01:00.000Z'), limit: 10 });
      expect(rows.map((r) => r.changedBy)).toEqual(['1']);
    });

    it('applies the limit', async () => {
      const rows = await repo.history({ limit: 2 });
      expect(rows.map((r) => r.changedBy)).toEqual(['3', '2']);
    });
  });

  it('pages through changes with the same timestamp without skipping any', async () => {
    const tie = '2026-11-02T11:00:00.000Z';
    await update('auth.googleLogin', false, true, tie, 'first');
    await update('auth.googleLogin', true, true, tie, 'second');

    const [page1] = await repo.history({ limit: 1 });
    expect(page1.changedBy).toBe('second'); // same changed_at → higher id first

    const page2 = await repo.history({ before: page1.changedAt, beforeId: page1.id, limit: 1 });
    expect(page2.map((r) => r.changedBy)).toEqual(['first']);

    const page3 = await repo.history({
      before: page2[0].changedAt,
      beforeId: page2[0].id,
      limit: 1,
    });
    expect(page3).toEqual([]);
  });
});
