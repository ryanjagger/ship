import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /audit-runner\.spec\.ts/,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['line']],
  use: {
    trace: 'off',
    screenshot: 'off',
    ...devices['Desktop Chrome'],
  },
  timeout: 240000,
});
