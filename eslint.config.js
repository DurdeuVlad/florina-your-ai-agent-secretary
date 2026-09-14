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
      // `no-undef` does not understand TypeScript type-only references
      // (e.g. the `NodeJS` namespace). The TypeScript compiler already
      // checks for undefined references, so disable it for TS files.
      'no-undef': 'off',
      // Honor the `_`-prefix convention for intentionally-unused args and
      // variables (e.g. handler signatures that must accept a parameter
      // they do not use).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['eslint.config.js', 'scripts/**/*.mjs', 'scripts/**/*.cjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // The desktop renderer is a sandboxed browser context — no Node APIs.
    files: ['src/adapters/inbound/desktop/renderer/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  prettier,
];
