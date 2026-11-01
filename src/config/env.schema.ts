import { z } from 'zod';

/** Clients this codebase knows about. Each deployment serves exactly one of them. */
export const KNOWN_CLIENTS = ['demo', 'kvitka', 'wisla'] as const;
export type ClientCode = (typeof KNOWN_CLIENTS)[number];

const booleanFromString = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((value) => value === 'true' || value === '1');

/**
 * Environment variables of the service. Validated once at startup:
 * a missing or invalid value stops the process with a clear message.
 * Keep `.env.example` in sync with this schema.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url().default('mysql://wallet:wallet@localhost:3306/wallet_core'),
  REDIS_URL: z.url().default('redis://localhost:6379'),
  CLIENT: z.enum(KNOWN_CLIENTS).default('demo'),
  DEV_AUTH: booleanFromString,
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174'),
  APP_VERSION: z.string().optional(),
  // Placeholders for the real JWT strategy (not used yet).
  JWT_ISSUER: z.string().default('wallet-core'),
  JWT_PUBLIC_KEY: z.string().optional(),
  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
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
