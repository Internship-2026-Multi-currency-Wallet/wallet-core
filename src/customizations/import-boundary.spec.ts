import { ESLint } from 'eslint';

/**
 * Regression check of the ESLint import boundary (eslint.config.mjs): core code must not import
 * `customizations/clients/**`. The rule is lintText'ed with the real config for a few file paths, so
 * a later config block that replaces the rule's options (it once did, for `src/customizations/*.ts`)
 * makes this fail.
 */
const eslint = new ESLint({ cwd: process.cwd() });

async function boundaryViolations(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages
    .filter(
      (message) =>
        message.ruleId === 'no-restricted-imports' || message.ruleId === 'no-restricted-syntax',
    )
    .map((message) => message.message);
}

const FROM_OUTSIDE = `import { KvitkaModule } from '../customizations/clients/kvitka/kvitka.module.js';\nexport { KvitkaModule };\n`;
const FROM_SIBLING = `import { KvitkaModule } from './clients/kvitka/kvitka.module.js';\nexport { KvitkaModule };\n`;

describe('client import boundary (ESLint)', () => {
  it.each([
    ['a core module outside customizations/', 'src/health/health.module.ts', FROM_OUTSIDE],
    [
      'a file inside customizations/ (the reported bypass)',
      'src/customizations/hook-runner.ts',
      FROM_OUTSIDE,
    ],
    [
      'a file inside customizations/, short path',
      'src/customizations/hook-runner.ts',
      FROM_SIBLING,
    ],
  ])('rejects an import of a client module from %s', async (_name, filePath, code) => {
    expect(await boundaryViolations(filePath, code)).toHaveLength(1);
  });

  it.each([
    ['the aggregator', 'src/customizations/customizations.module.ts', FROM_SIBLING],
    [
      'a client module (its own folder)',
      'src/customizations/clients/kvitka/kvitka.module.ts',
      `import { KvitkaModule } from '../kvitka/kvitka.module.js';\nexport { KvitkaModule };\n`,
    ],
    [
      'a spec file',
      'src/customizations/customizations.module.spec.ts',
      `import { KvitkaModule } from './clients/kvitka/kvitka.module.js';\nexport { KvitkaModule };\n`,
    ],
  ])('allows the import in %s', async (_name, filePath, code) => {
    expect(await boundaryViolations(filePath, code)).toEqual([]);
  });

  it.each([
    ['src/health/health.module.ts', '../customizations/clients/kvitka/kvitka.module.js'],
    ['src/health/health.module.ts', 'src/customizations/clients/kvitka/kvitka.module.js'],
    ['src/customizations/hook-runner.ts', '../customizations/clients/kvitka/kvitka.module.js'],
    ['src/customizations/hook-runner.ts', './clients/kvitka/kvitka.module.js'],
  ])('rejects a literal dynamic import in %s of %s', async (filePath, source) => {
    expect(
      await boundaryViolations(filePath, `export const load = () => import('${source}');\n`),
    ).toHaveLength(1);
  });

  it.each([
    ['src/customizations/customizations.module.ts', './clients/kvitka/kvitka.module.js'],
    ['src/customizations/clients/kvitka/kvitka.module.ts', '../../clients/wisla/wisla.module.js'],
    [
      'src/customizations/clients/kvitka/kvitka.module.ts',
      'src/customizations/clients/wisla/wisla.module.js',
    ],
    ['src/customizations/customizations.module.spec.ts', './clients/kvitka/kvitka.module.js'],
    ['src/health/health.module.ts', '../config/app-config.js'],
    ['src/customizations/hook-runner.ts', './hook-registry.js'],
    ['src/health/health.module.ts', '../customizations/clients-other/module.js'],
    ['src/customizations/hook-runner.ts', './clients-other/module.js'],
  ])('allows a literal dynamic import in %s of %s', async (filePath, source) => {
    expect(
      await boundaryViolations(filePath, `export const load = () => import('${source}');\n`),
    ).toEqual([]);
  });
});
