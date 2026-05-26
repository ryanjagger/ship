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
    },
    // Run test files sequentially to prevent database conflicts
    // Tests within each file can still run in parallel
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['node_modules', 'dist', 'src/test/**'],
    },
  },
})
