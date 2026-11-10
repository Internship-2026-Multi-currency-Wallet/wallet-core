/**
 * End-to-end tests: boot the whole app against real MySQL and Redis
 * (start them with the ops docker-compose stack, see README).
 * @type {import('jest').Config}
 */
export default {
  rootDir: '..',
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: '<rootDir>/tsconfig.json' }],
  },
  setupFiles: ['<rootDir>/test/preload-nest.ts', '<rootDir>/test/setup-env.ts'],
  testTimeout: 30000,
};
