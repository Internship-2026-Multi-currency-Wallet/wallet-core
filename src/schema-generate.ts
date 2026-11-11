/**
 * Writes `schema.graphql` from the code-first resolvers without serving traffic.
 * The database is not needed; Redis connects in the background and generation does not wait for it.
 *
 *   npm run schema:generate
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

process.env.NODE_ENV = 'development';
process.env.EMAIL_TRANSPORT = 'fake';
const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
await app.init();
await app.close();
process.stdout.write('schema.graphql written\n');
