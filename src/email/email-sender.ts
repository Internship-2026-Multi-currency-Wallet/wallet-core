export const EmailTemplate = {
  StaffInvitation: 'staffInvitation',
} as const;
export type EmailTemplate = (typeof EmailTemplate)[keyof typeof EmailTemplate];

export interface EmailMessage {
  template: EmailTemplate;
  to: string;
  data: Record<string, string>;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
