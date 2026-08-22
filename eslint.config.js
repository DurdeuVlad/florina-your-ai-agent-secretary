import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // The base `no-redeclare` rule does not understand TypeScript
      // declaration merging between a `const` value and a same-named
      // `type` alias (the idiomatic "string enum" pattern). Disable it
      // for TS files; the type-aware variant is not enabled here.
      'no-redeclare': 'off',
    },
  },
  {
    files: ['eslint.config.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  prettier,
];
