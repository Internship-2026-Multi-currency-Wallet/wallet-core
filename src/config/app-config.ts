import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from '../logging/logger.options.js';
import {
  type AppEnv,
  type ClientCode,
  type Env,
  LOCAL_JWT_SECRET,
  validateEnv,
} from './env.schema.js';

export const SERVICE_NAME = 'wallet-core';

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Typed, validated application config. Inject `AppConfig` instead of reading `process.env`.
 */
export class AppConfig {
  readonly serviceName = SERVICE_NAME;
  readonly version: string;
  readonly nodeEnv: Env['NODE_ENV'];
  /** Environment (`APP_ENV`): local, staging, kvitka-uat, wisla-uat. Prefix of all Redis keys. */
  readonly appEnv: AppEnv;
  readonly port: number;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  /** The client this deployment serves (`CLIENT` env). */
  readonly client: ClientCode;
  /** `DEV_AUTH=true` enables the `Authorization: Dev <userId>:<permissions>` header. */
  readonly devAuth: boolean;
  readonly corsOrigins: string[];
  /** Back office base URL (`BACKOFFICE_URL`) without trailing slashes. */
  readonly backofficeUrl: string;
  /** `BOOTSTRAP_ADMIN_EMAIL`: the first admin to invite when none exists; undefined when unset or empty. */
  readonly bootstrapAdminEmail: string | undefined;
  /** `LOG_LEVEL`: fatal, error, warn, info (default), debug, trace, silent. */
  readonly logLevel: LogLevel;
  readonly jwt: {
    issuer: string;
    secret: string;
    accessTtlSeconds: number;
    sessionTtlSeconds: number;
  };

  constructor(env: Env) {
    this.version = env.APP_VERSION ?? readPackageVersion();
    this.nodeEnv = env.NODE_ENV;
    this.appEnv = env.APP_ENV;
    this.port = env.PORT;
    this.databaseUrl = env.DATABASE_URL;
    this.redisUrl = env.REDIS_URL;
    this.client = env.CLIENT;
    this.devAuth = env.DEV_AUTH;
    this.backofficeUrl = env.BACKOFFICE_URL.replace(/\/+$/, '');
    this.bootstrapAdminEmail = env.BOOTSTRAP_ADMIN_EMAIL || undefined;
    this.logLevel = env.LOG_LEVEL;
    this.corsOrigins = env.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    this.jwt = {
      issuer: env.JWT_ISSUER,
      secret: env.JWT_SECRET ?? LOCAL_JWT_SECRET,
      accessTtlSeconds: env.JWT_ACCESS_TTL,
      sessionTtlSeconds: env.JWT_REFRESH_TTL,
    };
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
    return new AppConfig(validateEnv(env));
  }
}
