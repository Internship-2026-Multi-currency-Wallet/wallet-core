import type { AppEnv } from '../config/env.schema.js';
import { formatCreateAdminResult } from './create-admin-output.js';
import type { CreateAdminResult } from './staff-bootstrap.service.js';

const TOKEN = 'secret-token-123';
const LINK = `https://bo.test/accept-invitation?token=${TOKEN}`;
const EMAIL = 'admin@test.com';

const withLink = (outcome: 'created' | 'resent'): CreateAdminResult => ({
  outcome,
  staffId: 'id-1',
  link: LINK,
});
const withoutLink: CreateAdminResult[] = [
  { outcome: 'adminExists' },
  { outcome: 'emailTaken' },
  { outcome: 'invalidEmail' },
];

describe('formatCreateAdminResult', () => {
  it.each(['created', 'resent'] as const)(
    'prints the link for %s with APP_ENV=local',
    (outcome) => {
      expect(formatCreateAdminResult(withLink(outcome), 'local')).toContain(LINK);
    },
  );

  it.each(['staging', 'kvitka-uat', 'wisla-uat'] as AppEnv[])(
    'prints neither link nor token with APP_ENV=%s and says the email was sent',
    (appEnv) => {
      for (const outcome of ['created', 'resent'] as const) {
        const out = formatCreateAdminResult(withLink(outcome), appEnv);
        expect(out).not.toContain(LINK);
        expect(out).not.toContain(TOKEN);
        expect(out).toContain('sent by email');
      }
    },
  );

  it('uses a distinct line per outcome', () => {
    const lines = [withLink('created'), withLink('resent'), ...withoutLink].map((r) =>
      formatCreateAdminResult(r, 'staging'),
    );
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('never prints the email address', () => {
    for (const r of [withLink('created'), withLink('resent'), ...withoutLink]) {
      expect(formatCreateAdminResult(r, 'local').replace(LINK, '')).not.toContain(EMAIL);
    }
  });
});
