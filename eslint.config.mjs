// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const CLIENTS_IMPORT_MESSAGE =
  'Core code must not import client customizations. Only CustomizationsModule lists the client modules.';

// esquery needs Unicode escapes for slashes inside a selector's regular expression.
const CLIENTS_DYNAMIC_IMPORT = {
  selector:
    'ImportExpression[source.type="Literal"][source.value=/(^|\\u002F)customizations\\u002Fclients\\u002F/]',
  message: CLIENTS_IMPORT_MESSAGE,
};

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', '*.mjs', 'test/*.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Core code never depends on client customizations: the dependency runs from `clients/` to the
    // core, and only `CustomizationsModule` lists the client modules.
    files: ['src/**/*.ts'],
    ignores: [
      'src/customizations/customizations.module.ts',
      'src/customizations/clients/**',
      'src/**/*.spec.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', CLIENTS_DYNAMIC_IMPORT],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/customizations/clients/**'],
              message: CLIENTS_IMPORT_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  {
    // Files that sit next to `clients/` import it as `./clients/...`. A later config object REPLACES
    // the options of an earlier one for the same rule, so this one repeats the broader pattern.
    files: ['src/customizations/*.ts'],
    ignores: ['src/customizations/customizations.module.ts', 'src/**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        CLIENTS_DYNAMIC_IMPORT,
        {
          selector:
            'ImportExpression[source.type="Literal"][source.value=/^\\.\\u002Fclients\\u002F/]',
          message: CLIENTS_IMPORT_MESSAGE,
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/customizations/clients/**', './clients/**'],
              message: CLIENTS_IMPORT_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
