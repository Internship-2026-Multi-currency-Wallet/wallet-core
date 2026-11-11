import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Knex } from 'knex';
import type { PinoLogger } from 'nestjs-pino';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/app-config.js';
import { createKnex } from '../src/database/database.module.js';
import { EmailService } from '../src/email/email.service.js';
import { FakeEmailService } from '../src/email/fake-email.service.js';
import { StaffBootstrapService } from '../src/staff/staff-bootstrap.service.js';

/** Admin bootstrap on application start, against real MySQL. */
describe('staff bootstrap (e2e, real MySQL)', () => {
  let db: Knex;
  // One fake shared by all applications of a test, so emails of every start are counted.
  const fake = new FakeEmailService({ info: () => undefined } as unknown as PinoLogger);
  const sent = fake.sent;

  const startApp = async (): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AppConfig)
      .useValue(
        AppConfig.fromEnv({
          ...process.env,
          BOOTSTRAP_ADMIN_EMAIL: '  Boot@Test.com ',
          BACKOFFICE_URL: 'https://bo.test',
        }),
      )
      .overrideProvider(EmailService)
      .useValue(fake)
      .compile();
    const app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    await app.init();
    return app;
  };

  const clean = async () => {
    await db('staff_sessions').delete();
    await db('staff_invitations').delete();
    await db('staff').delete();
  };

  beforeAll(() => {
    db = createKnex(process.env.DATABASE_URL!);
  });

  beforeEach(async () => {
    sent.length = 0;
    await clean();
  });

  afterAll(async () => {
    await clean();
    await db.destroy();
  });

  it('invites the admin once across two starts', async () => {
    const first = await startApp();
    await first.close();
    const second = await startApp();
    await second.close();

    const rows = await db('staff').select('email', 'role', 'status');
    expect(rows).toEqual([{ email: 'boot@test.com', role: 'ADMIN', status: 'INVITED' }]);
    expect(await db('staff_invitations').count({ n: '*' }).first()).toEqual({ n: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('boot@test.com');
  });

  it('invites exactly one admin when two applications start concurrently', async () => {
    const apps = await Promise.all([startApp(), startApp()]);
    await Promise.all(apps.map((app) => app.close()));

    expect(await db('staff').count({ n: '*' }).first()).toEqual({ n: 1 });
    expect(sent).toHaveLength(1);
  });

  describe('concurrent callers with different emails', () => {
    let app: INestApplication;
    let bootstrap: StaffBootstrapService;

    beforeEach(async () => {
      app = await startApp();
      await clean();
      sent.length = 0;
      bootstrap = app.get(StaffBootstrapService);
    });

    afterEach(async () => {
      await app.close();
    });

    it('creates exactly one admin when three bootstrapAdmin calls race', async () => {
      const results = await Promise.all([
        bootstrap.bootstrapAdmin('a@test.com'),
        bootstrap.bootstrapAdmin('b@test.com'),
        bootstrap.bootstrapAdmin('c@test.com'),
      ]);

      expect(results.map((r) => r.outcome).sort()).toEqual([
        'adminExists',
        'adminExists',
        'created',
      ]);
      expect(await db('staff').where({ role: 'ADMIN' }).count({ n: '*' }).first()).toEqual({
        n: 1,
      });
      expect(sent).toHaveLength(1);
    });

    it('creates exactly one admin when createAdminOrReissue races bootstrapAdmin', async () => {
      const results = await Promise.all([
        bootstrap.bootstrapAdmin('a@test.com'),
        bootstrap.createAdminOrReissue('b@test.com'),
      ]);

      expect(results.map((r) => r.outcome).sort()).toEqual(['adminExists', 'created']);
      expect(await db('staff').where({ role: 'ADMIN' }).count({ n: '*' }).first()).toEqual({
        n: 1,
      });
      expect(sent).toHaveLength(1);
    });
  });
});
