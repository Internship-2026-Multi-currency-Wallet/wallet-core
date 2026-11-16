import type { AppEnv } from '../config/env.schema.js';

/** `testCredit` mints fake money, so it exists only outside client UAT environments (local and staging). */
export function isTestCreditAllowed(appEnv: AppEnv): boolean {
  return !appEnv.endsWith('-uat');
}
