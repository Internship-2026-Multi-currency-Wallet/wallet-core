import { Controller, Get, Header, NotFoundException, Param } from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';
import { brand } from '../brand/brand.js';
import { AppConfig } from '../config/app-config.js';
import type { EmailTemplate } from './email.service.js';
import { renderEmail, sampleData } from './templates/index.js';

const NOT_FOUND = 'Not found';

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Dev-only preview of the email templates rendered with sample data. Off unless EMAIL_PREVIEW_ENABLED. */
@Controller('dev/email-preview')
export class EmailPreviewController {
  constructor(private readonly config: AppConfig) {}

  @Public()
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  list(): string {
    this.assertEnabled();
    const items = Object.keys(sampleData)
      .map(
        (name) =>
          `<li><a href="/dev/email-preview/${escapeHtml(name)}">${escapeHtml(name)}</a></li>`,
      )
      .join('');
    return `<!doctype html><html><body><h1>Email templates</h1><ul>${items}</ul></body></html>`;
  }

  @Public()
  @Get(':template')
  @Header('Content-Type', 'text/html; charset=utf-8')
  render(@Param('template') template: string): string {
    this.assertEnabled();
    // hasOwn keeps `constructor`, `toString` and `__proto__` from matching.
    if (!Object.hasOwn(sampleData, template)) throw new NotFoundException(NOT_FOUND);
    const name = template as EmailTemplate;
    return renderEmail(name, sampleData[name], brand).html;
  }

  private assertEnabled(): void {
    if (!this.config.emailPreviewEnabled) throw new NotFoundException(NOT_FOUND);
  }
}
