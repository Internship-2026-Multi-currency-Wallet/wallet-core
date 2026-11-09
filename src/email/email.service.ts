export interface EmailTemplates {
  staffInvitation: { link: string };
  passwordReset: { link: string };
  passwordChanged: Record<string, never>;
}

export type EmailTemplate = keyof EmailTemplates;

/** DI token and contract: inject `EmailService` anywhere (EmailModule is global). */
export abstract class EmailService {
  abstract send<T extends EmailTemplate>(
    template: T,
    to: string,
    data: EmailTemplates[T],
  ): Promise<void>;
}
