import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
    // Target a DEDICATED test database, never the dev DB. db/client.ts reads
    // process.env.DATABASE_URL and dotenv does not override an already-set value,
    // so this wins over .env.local. The setup.ts guard double-checks the live DB
    // name contains "test" before truncating. Override via DATABASE_URL_TEST.
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL_TEST ||
        'postgresql://ship:ship_dev_password@localhost:5432/ship_test',
      NODE_ENV: 'test',
      // Never emit LangSmith traces from the suite. Models are mocked, but a
      // developer's .env.local LANGSMITH_TRACING=true must not leak into any
      // unmocked path and turn tests into network calls. These overrides win
      // over .env.local (vitest env injection takes precedence).
      LANGSMITH_TRACING: 'false',
      LANGSMITH_API_KEY: '',
    },
    // Run test files sequentially to prevent database conflicts
    // Tests within each file can still run in parallel
    fileParallelism: false,
    // Auto-retry flaky tests up to 2x. Some FleetGraph SSE/streaming tests are
    // timing-sensitive and intermittently fail under CI load (a different
    // assertion each run); a small retry keeps CI green without masking a
    // genuinely broken test, which fails all attempts.
    retry: 2,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['node_modules', 'dist', 'src/test/**'],
    },
  },
})
