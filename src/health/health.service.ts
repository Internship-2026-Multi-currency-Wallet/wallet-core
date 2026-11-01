import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Knex } from 'knex';
import { AppConfig } from '../config/app-config.js';
import { KNEX } from '../database/database.module.js';
import { REDIS } from '../redis/redis.module.js';
import { DependencyStatus, type Health } from './health.model.js';

const CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS).unref(),
    ),
  ]);
}

@Injectable()
export class HealthService {
  constructor(
    private readonly config: AppConfig,
    @Inject(KNEX) private readonly db: Knex,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async check(): Promise<Health> {
    const [db, redis] = await Promise.all([this.checkDb(), this.checkRedis()]);
    return {
      service: this.config.serviceName,
      version: this.config.version,
      client: this.config.client,
      db,
      redis,
    };
  }

  private async checkDb(): Promise<DependencyStatus> {
    try {
      await withTimeout(this.db.raw('select 1'));
      return DependencyStatus.UP;
    } catch {
      return DependencyStatus.DOWN;
    }
  }

  private async checkRedis(): Promise<DependencyStatus> {
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      await withTimeout(this.redis.ping());
      return DependencyStatus.UP;
    } catch {
      return DependencyStatus.DOWN;
    }
  }
}
