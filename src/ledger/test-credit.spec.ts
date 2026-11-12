import { APP_ENVS, type AppEnv } from '../config/env.schema.js';
import { isTestCreditAllowed } from './test-credit.js';

// A Record makes the compiler demand a row for every new APP_ENV.
const EXPECTED: Record<AppEnv, boolean> = {
  local: true,
  staging: true,
  'kvitka-uat': false,
  'wisla-uat': false,
};

describe('isTestCreditAllowed', () => {
  it.each(APP_ENVS)('%s', (appEnv) => {
    expect(isTestCreditAllowed(appEnv)).toBe(EXPECTED[appEnv]);
  });
});
