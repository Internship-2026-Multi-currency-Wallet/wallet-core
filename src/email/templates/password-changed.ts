import type { Brand } from '../../brand/brand.js';
import type { Content } from './layout.js';

export const passwordChanged = (_data: Record<string, never>, b: Brand): Content => ({
  subject: `Your ${b.name} password was changed`,
  heading: 'Your password was changed',
  paragraphs: ["If this wasn't you, contact support."],
  text: "Your password was changed.\n\nIf this wasn't you, contact support.\n",
});
