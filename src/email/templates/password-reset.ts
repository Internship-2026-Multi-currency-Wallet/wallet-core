import type { Brand } from '../../brand/brand.js';
import type { Content } from './layout.js';

export const passwordReset = (data: { link: string }, b: Brand): Content => ({
  subject: `Reset your ${b.name} password`,
  heading: 'Reset your password',
  paragraphs: [
    "Use the button below to choose a new password. If you didn't ask for this, ignore this email.",
  ],
  button: { label: 'Reset password', href: data.link },
  text: `Reset your password: ${data.link}\n\nIf you didn't ask for this, ignore this email.\n`,
});
