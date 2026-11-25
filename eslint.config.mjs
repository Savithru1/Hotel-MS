import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.data/**',
      'pnpm-lock.yaml',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Raw driver access skips the tenant plugin, so a query through it is not limited to one
    // property. Go through the mongoose models instead.
    files: ['apps/backend/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          property: 'collection',
          message:
            'Raw collection access bypasses tenant scoping. Use the mongoose model (see shared/tenant-plugin.ts).',
        },
      ],
    },
  },
  {
    // Plain Node config files may use the console and are not part of any TS project.
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: { sourceType: 'module' },
  },
  prettier,
);
