// Flat ESLint config for the Ship monorepo.
//
// Purpose: type-safety detection only. Rules are intentionally scoped to the
// findings in audit/type-safety/README.md and audit/type-safety/peer-review.md.
// Everything is set to "warn" so the lint run produces a baseline without
// failing builds. The baseline is captured in audit/type-safety/baseline/.
//
// Type-aware rules use `projectService: true` so each package's tsconfig is
// auto-discovered. This is slower than syntactic rules but is what gives us
// accurate counts for no-non-null-assertion and the no-unsafe-* family — the
// exact things the regex-based count.sh under- or mis-counted.

import js from '@eslint/js';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import globals from 'globals';

// Derive __dirname rather than rely on `import.meta.dirname`, which is only
// available from Node 20.11+. package.json#engines allows >= 20.0.0.
const __dirname = dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
      'audit/**',
      'scripts/**',
      'docs/**',
      'e2e/test-results/**',
      'web/public/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      // Type-safety detection (the point of this config).
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/consistent-type-assertions': [
        'warn',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'allow-as-parameter' },
      ],
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',

      // Off: noise that isn't the focus of this audit. Re-enable later if useful.
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      'no-empty': 'off',
      'no-constant-condition': 'off',
      'no-useless-escape': 'off',
      'no-control-regex': 'off',
      'no-async-promise-executor': 'off',
      'no-prototype-builtins': 'off',
      'prefer-const': 'off',
      'no-case-declarations': 'off',
    },
  },

  // Test files: keep type-safety signal on, but drop floating-promise noise.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**/*.ts', '**/__tests__/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // Public/internal boundary (PRD §5.1). The Platform API under
  // `api/src/platform/**` is a one-way door: it may call shared infra
  // (db client, middleware, services, @ship/shared) but must NOT import an
  // internal route handler from `api/src/routes/**`. Auth, scope, and audit
  // attach only at the public layer. Set to `error` (not the audit-wide
  // `warn`) because this is an architectural invariant, not a style nit.
  // Added before any such imports exist — cheaper to enforce than retrofit.
  {
    files: ['api/src/platform/**/*.ts', 'api/src/platform/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Match imports that climb OUT of the platform tree into
              // api/src/routes (any depth: ../routes, ../../routes, …). Does NOT
              // match the platform's OWN routes subfolder (./routes/*), so the
              // v1 router can still mount its own resource routes.
              group: ['../**/routes/*', '../**/routes/**'],
              message:
                'Platform API (api/src/platform/**) must not import internal route handlers (api/src/routes/**). Call the shared db/services layer directly instead. See PRD §5.1.',
            },
          ],
        },
      ],
    },
  },
);
