import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Knex } from 'knex';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/app-config.js';
import { createKnex } from '../src/database/database.module.js';
import { EMAIL_SENDER, type EmailMessage } from '../src/email/email-sender.js';

/** Admin bootstrap on application start, against real MySQL. */
describe('staff bootstrap (e2e, real MySQL)', () => {
  let db: Knex;
  const sent: EmailMessage[] = [];

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
      .overrideProvider(EMAIL_SENDER)
      .useValue({
        send: (message: EmailMessage) => {
          sent.push(message);
          return Promise.resolve();
        },
      })
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
});
