import type { Brand } from '../../brand/brand.js';

export interface Content {
  subject: string;
  heading: string;
  paragraphs: string[];
  button?: { label: string; href: string };
  text: string;
}

export const esc = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const layout = (c: Content, b: Brand): string => {
  const p = b.palette;
  const font = `font-family:${esc(b.fontFamily)};color:${esc(p.text)};`;
  const paragraphs = c.paragraphs
    .map((t) => `<p style="margin:0 0 16px;font-size:16px;line-height:24px;${font}">${esc(t)}</p>`)
    .join('');
  const button = c.button
    ? `<p style="margin:24px 0;"><a href="${esc(c.button.href)}" style="display:inline-block;padding:12px 24px;border-radius:6px;background:${esc(p.primary)};text-decoration:none;${font}color:#FFFFFF;">${esc(c.button.label)}</a></p>` +
      `<p style="margin:0 0 16px;font-size:13px;${font}">Or open this link: <a href="${esc(c.button.href)}" style="color:${esc(p.secondary)};">${esc(c.button.href)}</a></p>`
    : '';
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:${esc(p.background)};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${esc(p.background)};"><tr><td align="center" style="padding:24px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border-top:4px solid ${esc(p.primary)};">
<tr><td style="padding:24px;"><img src="${esc(b.logoUrl)}" alt="${esc(b.name)}" height="40" style="vertical-align:middle;border:0;"></td></tr>
<tr><td style="padding:0 24px;"><h1 style="margin:0 0 16px;font-size:22px;${font}">${esc(c.heading)}</h1>${paragraphs}${button}</td></tr>
<tr><td style="padding:24px;font-size:12px;${font}">&copy; ${esc(b.name)}</td></tr>
</table></td></tr></table>
</body></html>`;
};
