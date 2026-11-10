import type { Brand } from '../../brand/brand.js';
import type { Content } from './layout.js';

export const staffInvitation = (data: { link: string }, b: Brand): Content => ({
  subject: `You've been invited to the ${b.name} back office`,
  heading: `You've been invited to the ${b.name} back office`,
  paragraphs: ['Use the button below to accept the invitation and set up your account.'],
  button: { label: 'Accept invitation', href: data.link },
  text: `You've been invited to the ${b.name} back office.\n\nAccept the invitation: ${data.link}\n`,
});
