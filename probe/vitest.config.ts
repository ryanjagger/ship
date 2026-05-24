import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // jsdom env (opted into per-file via `// @vitest-environment jsdom`) needs
    // a non-about:blank URL or its Storage implementation throws on access.
    environmentOptions: {
      jsdom: {
        url: 'http://localhost/',
      },
    },
  },
});
