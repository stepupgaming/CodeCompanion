import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/', 'dist/', 'coverage/', '**/*.tsbuildinfo'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ['src/renderer/src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Test code, mock servers and the e2e harness are allowed to reach for `any`; production sources are not.
    files: ['**/*.test.ts', 'tests/e2e/**', 'tests/perf/**', 'src/main/llm/test_server.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-useless-assignment': 'off',
      'prefer-const': 'off',
    },
  },
  {
    rules: {
      // `_`-prefixed bindings signal deliberate omission (e.g. the destructure-to-drop idiom).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
