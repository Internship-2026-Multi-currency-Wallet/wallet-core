import type { Brand } from '../../brand/brand.js';
import type { EmailTemplate, EmailTemplates } from '../email.service.js';
import { layout, type Content } from './layout.js';
import { passwordChanged } from './password-changed.js';
import { passwordReset } from './password-reset.js';
import { staffInvitation } from './staff-invitation.js';

const builders: { [T in EmailTemplate]: (data: EmailTemplates[T], b: Brand) => Content } = {
  staffInvitation,
  passwordReset,
  passwordChanged,
};

export const sampleData: { [T in EmailTemplate]: EmailTemplates[T] } = {
  staffInvitation: { link: 'https://backoffice.example.com/accept?token=sample' },
  passwordReset: { link: 'https://backoffice.example.com/reset?token=sample' },
  passwordChanged: {},
};

export const renderEmail = <T extends EmailTemplate>(
  template: T,
  data: EmailTemplates[T],
  brand: Brand,
): { subject: string; html: string; text: string } => {
  const content = builders[template](data, brand);
  return { subject: content.subject, html: layout(content, brand), text: content.text };
};
