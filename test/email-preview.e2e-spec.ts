import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createApp } from './create-app.js';

const get = (app: INestApplication, path: string) => request(app.getHttpServer() as App).get(path);

describe('email preview (e2e)', () => {
  describe('enabled', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createApp({ EMAIL_PREVIEW_ENABLED: 'true' });
    });

    afterAll(async () => {
      await app.close();
    });

    it('renders a template as html without an Authorization header', async () => {
      const res = await get(app, '/dev/email-preview/staffInvitation').expect(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.text).toContain('https://backoffice.example.com/accept?token=sample');
      expect(res.text).toContain('Demo Wallet');
    });

    it('lists all template names with links', async () => {
      const res = await get(app, '/dev/email-preview').expect(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      for (const name of ['staffInvitation', 'passwordReset', 'passwordChanged']) {
        expect(res.text).toContain(`href="/dev/email-preview/${name}"`);
      }
    });

    it('answers 404 without echoing an unknown template name', async () => {
      const res = await get(app, '/dev/email-preview/nope').expect(404);
      expect(res.text).not.toContain('nope');
    });

    it.each(['constructor', 'toString', '__proto__'])('answers 404 for %s', async (name) => {
      await get(app, `/dev/email-preview/${name}`).expect(404);
    });

    it('ignores query parameters', async () => {
      const plain = await get(app, '/dev/email-preview/staffInvitation').expect(200);
      const res = await get(
        app,
        '/dev/email-preview/staffInvitation?link=<script>alert(1)</script>',
      ).expect(200);
      expect(res.text).toBe(plain.text);
      expect(res.text).not.toContain('<script>');
    });
  });

  describe('disabled (default)', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createApp({ EMAIL_PREVIEW_ENABLED: 'false' });
    });

    afterAll(async () => {
      await app.close();
    });

    it.each(['/dev/email-preview', '/dev/email-preview/staffInvitation'])(
      'answers 404 for %s',
      async (path) => {
        await get(app, path).expect(404);
      },
    );
  });
});
