import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'node_modules/',
      'coverage/',
      'e2e/fixtures/',
      '.specstory/',
      '.codegraph/',
      '.zvec-grep/',
      '.claude/',
      '.agents/',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/consistent-type-imports': 'warn',
    },
  },
  {
    files: ['src/**/*.test.ts', 'src/__tests__/**/*.ts', 'e2e/**/*.ts'],
    languageOptions: {
      globals: globals.vitest,
    },
    rules: {
      // Tests poke at DAP payloads and private state; typing every fixture isn't worth it.
      '@typescript-eslint/no-explicit-any': 'off',
      // Fakes build object literals whose methods close over the fake.
      '@typescript-eslint/no-this-alias': ['error', { allowedNames: ['self'] }],
    },
  },
  prettier,
);
