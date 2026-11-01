/**
 * Writes `schema.graphql` from the code-first resolvers without serving traffic.
 * Database and Redis are not needed (connections are lazy).
 *
 *   npm run schema:generate
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

process.env.NODE_ENV = 'development';
const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
await app.init();
await app.close();
console.log('schema.graphql written');
