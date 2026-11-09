import type { INestApplication } from '@nestjs/common';
import { EmailService } from '../src/email/email.service.js';
import { FakeEmailService } from '../src/email/fake-email.service.js';
import { createApp } from './create-app.js';

describe('email module (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('binds EmailService to the recording fake', async () => {
    const email = app.get(EmailService);
    expect(email).toBeInstanceOf(FakeEmailService);
    await email.send('passwordReset', 'a@example.com', { link: 'https://x.test/r' });
    expect((email as FakeEmailService).sent).toEqual([
      { template: 'passwordReset', to: 'a@example.com', data: { link: 'https://x.test/r' } },
    ]);
  });
});
