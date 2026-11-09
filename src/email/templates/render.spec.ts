import { describe, expect, it } from '@jest/globals';
import { brand, type Brand } from '../../brand/brand.js';
import type { EmailTemplate, EmailTemplates } from '../email.service.js';
import { renderEmail, sampleData } from './index.js';

const templates: EmailTemplate[] = ['staffInvitation', 'passwordReset', 'passwordChanged'];

const kvitka: Brand = {
  name: 'Kvitka Bank',
  senderName: 'Kvitka Bank',
  logoUrl: 'https://kvitka.example/logo.svg',
  palette: { primary: '#1E3A8A', secondary: '#F5B700', background: '#FFFFFF', text: '#111111' },
  fontFamily: 'Arial, sans-serif',
};

describe('renderEmail', () => {
  it.each(templates)('renders non-empty subject, html and text for %s', (template) => {
    const out = renderEmail(template, sampleData[template], brand);
    expect(out.subject.length).toBeGreaterThan(0);
    expect(out.html.length).toBeGreaterThan(0);
    expect(out.text.length).toBeGreaterThan(0);
  });

  it.each(templates)('puts the brand name, logo and primary colour into %s', (template) => {
    const { html } = renderEmail(template, sampleData[template], brand);
    expect(html).toContain(brand.name);
    expect(html).toContain(brand.logoUrl);
    expect(html).toContain(brand.palette.primary);
  });

  it.each(templates)('uses only the given brand for %s', (template) => {
    const out = renderEmail(template, sampleData[template], kvitka);
    const all = `${out.subject}\n${out.html}\n${out.text}`;
    expect(out.html).toContain('Kvitka Bank');
    expect(out.html).toContain('https://kvitka.example/logo.svg');
    expect(out.html).toContain('#1E3A8A');
    expect(all).not.toContain('Demo Wallet');
    expect(all).not.toContain('#4F46E5');
    expect(all).not.toContain(brand.logoUrl);
  });

  it.each(['staffInvitation', 'passwordReset'] as const)(
    'has the link as href in html and in full in text for %s',
    (template) => {
      const link = 'https://app.example/x?token=abc123';
      const out = renderEmail(template, { link }, brand);
      expect(out.html).toContain(`href="${link}"`);
      expect(out.text).toContain(link);
    },
  );

  it('escapes a hostile link so it cannot inject markup or break out of href', () => {
    const link = 'https://a.example/?q="><script>alert(1)</script>&x=1';
    const { html } = renderEmail('passwordReset', { link }, brand);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="https://a.example/?q="');
    expect(html).toContain(
      'href="https://a.example/?q=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;x=1"',
    );
  });

  it('escapes brand values in attributes and text', () => {
    const evil: Brand = { ...kvitka, name: 'A"<b>&\'', logoUrl: 'x"onerror="1' };
    const { html } = renderEmail('passwordChanged', {}, evil);
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('x"onerror');
    expect(html).toContain('A&quot;&lt;b&gt;&amp;&#39;');
  });

  it('renders passwordChanged with empty data', () => {
    const out = renderEmail('passwordChanged', {}, brand);
    expect(out.html).toContain('If this wasn&#39;t you, contact support.');
    expect(out.text).toContain("If this wasn't you, contact support.");
  });

  it('has sample data for every template', () => {
    const samples = sampleData satisfies EmailTemplates;
    expect(Object.keys(samples).sort()).toEqual([...templates].sort());
  });
});
