import { z } from 'zod';
import { LOG_LEVELS } from '../logging/logger.options.js';

/** Clients this codebase knows about. Each deployment serves exactly one of them. */
export const KNOWN_CLIENTS = ['demo', 'kvitka', 'wisla'] as const;
export type ClientCode = (typeof KNOWN_CLIENTS)[number];

/**
 * Environment this deployment belongs to. Prefixes all Redis keys (`kvitka-uat:rate.tick`),
 * so several environments can share one Redis.
 */
export const APP_ENVS = ['local', 'staging', 'kvitka-uat', 'wisla-uat'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** Dev auth is allowed only outside client UAT environments. */
export function isDevAuthAllowed(appEnv: AppEnv): boolean {
  return !appEnv.endsWith('-uat');
}

const booleanFromString = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((value) => value === 'true' || value === '1');

/** Must match rates-service's local default so development tokens work across services. */
export const LOCAL_JWT_SECRET = 'local-only-jwt-secret-change-me-0123456789';

const SECONDS_PER_UNIT = { s: 1, m: 60, h: 3600, d: 86400 } as const;
type DurationUnit = keyof typeof SECONDS_PER_UNIT;
// Without a bound a long number passes the regex and becomes Infinity.
const MAX_DURATION_SECONDS = 365 * SECONDS_PER_UNIT.d;

function durationInSeconds(defaultValue: `${number}${DurationUnit}`) {
  return z
    .string()
    .regex(/^[1-9]\d*[smhd]$/, 'must be a positive number followed by s, m, h or d, e.g. 15m')
    .default(defaultValue)
    .transform((value) => {
      const unit = value.slice(-1) as DurationUnit;
      return Number(value.slice(0, -1)) * SECONDS_PER_UNIT[unit];
    })
    .refine((seconds) => seconds <= MAX_DURATION_SECONDS, 'must be at most 365d');
}

/**
 * Environment variables of the service. Validated once at startup:
 * a missing or invalid value stops the process with a clear message.
 * Keep `.env.example` in sync with this schema.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ENV: z.enum(APP_ENVS).default('local'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.url().default('mysql://wallet:wallet@localhost:3306/wallet_core'),
    REDIS_URL: z.url().default('redis://localhost:6379'),
    CLIENT: z.enum(KNOWN_CLIENTS).default('demo'),
    DEV_AUTH: booleanFromString,
    CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174'),
    // Base of the links in staff emails (`<BACKOFFICE_URL>/accept-invitation?token=...`).
    BACKOFFICE_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:5174'),
    APP_VERSION: z.string().optional(),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    JWT_ISSUER: z.string().min(1).default('wallet-core'),
    // Shared with rates-service and treasury-service, which verify the tokens with it (HS256).
    JWT_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
    JWT_ACCESS_TTL: durationInSeconds('15m'),
    // Lifetime of a session (refresh token), counted from login.
    JWT_REFRESH_TTL: durationInSeconds('30d'),
  })
  .superRefine((env, ctx) => {
    // Every deployed image runs with NODE_ENV=production, so a server cannot fall back to the
    // public local secret.
    if (env.NODE_ENV === 'production' && env.JWT_SECRET === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'is required in production (the HS256 secret shared with the other services)',
      });
    }
    if (env.NODE_ENV === 'production' && env.JWT_SECRET === LOCAL_JWT_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'must not be the local-only secret in production',
      });
    }
    if (env.DEV_AUTH && !isDevAuthAllowed(env.APP_ENV)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_AUTH'],
        message: `DEV_AUTH=true is not allowed in client environment "${env.APP_ENV}" (only local and staging)`,
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: NodeJS.ProcessEnv): Env {
  // Treat empty strings as "not set", so `FOO=` in .env falls back to the default.
  const cleaned = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== ''));
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}
