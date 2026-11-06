/**
 * Invites the first admin, or re-issues the invitation of an admin whose link expired.
 * The link is printed only with APP_ENV=local.
 *
 *   npm run staff:create-admin [-- email]
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { AppConfig } from './config/app-config.js';
import { formatCreateAdminResult } from './staff/create-admin-output.js';
import { StaffBootstrapService } from './staff/staff-bootstrap.service.js';

// Removed before the context exists, so the start hook does not also bootstrap.
const envEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
delete process.env.BOOTSTRAP_ADMIN_EMAIL;

const email = process.argv[2] ?? envEmail;
if (!email) {
  process.stdout.write('Usage: npm run staff:create-admin -- <email>\n');
  process.exit(1);
}

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
const result = await app.get(StaffBootstrapService).createAdminOrReissue(email);
process.stdout.write(formatCreateAdminResult(result, app.get(AppConfig).appEnv));
await app.close();
process.exitCode = result.outcome === 'created' || result.outcome === 'resent' ? 0 : 1;
