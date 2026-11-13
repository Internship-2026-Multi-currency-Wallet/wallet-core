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
  readonly metricsPort: number;
  readonly metricsHost: string;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  /** The client this deployment serves (`CLIENT` env). */
  readonly client: ClientCode;
  /** `DEV_AUTH=true` enables the `Authorization: Dev <userId>:<permissions>` header. */
  readonly devAuth: boolean;
  /** `EMAIL_PREVIEW_ENABLED=true` serves the email template preview at `/dev/email-preview`. */
  readonly emailPreviewEnabled: boolean;
  readonly email: {
    transport: Env['EMAIL_TRANSPORT'];
    from: string;
    resendApiKey?: string;
    smtpUrl: string;
  };
  readonly corsOrigins: string[];
  readonly backofficeUrl: string;
  readonly bootstrapAdminEmail: string | undefined;
  /** `LOG_LEVEL`: fatal, error, warn, info (default), debug, trace, silent. */
  readonly logLevel: LogLevel;
  readonly jwt: {
    issuer: string;
    secret: string;
    accessTtlSeconds: number;
    sessionTtlSeconds: number;
  };
  readonly google: { clientId?: string; clientSecret?: string };
  readonly throttle: { ttlSeconds: number; limitAnonymous: number; limitUser: number };

  constructor(env: Env) {
    this.version = env.APP_VERSION ?? readPackageVersion();
    this.nodeEnv = env.NODE_ENV;
    this.appEnv = env.APP_ENV;
    this.port = env.PORT;
    this.metricsPort = env.METRICS_PORT;
    this.metricsHost = env.METRICS_HOST;
    this.databaseUrl = env.DATABASE_URL;
    this.redisUrl = env.REDIS_URL;
    this.client = env.CLIENT;
    this.devAuth = env.DEV_AUTH;
    this.backofficeUrl = env.BACKOFFICE_URL.replace(/\/+$/, '');
    this.bootstrapAdminEmail = env.BOOTSTRAP_ADMIN_EMAIL || undefined;
    this.emailPreviewEnabled = env.EMAIL_PREVIEW_ENABLED;
    this.email = {
      transport: env.EMAIL_TRANSPORT,
      from: env.EMAIL_FROM,
      resendApiKey: env.RESEND_API_KEY,
      smtpUrl: env.SMTP_URL,
    };
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
    this.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
    this.throttle = {
      ttlSeconds: env.THROTTLE_TTL_SECONDS,
      limitAnonymous: env.THROTTLE_LIMIT_ANONYMOUS,
      limitUser: env.THROTTLE_LIMIT_USER,
    };
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
    return new AppConfig(validateEnv(env));
  }
}
