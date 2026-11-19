import { defineConfig } from '@playwright/test';

const TEST_SERVER_PORT = Number(process.env.E2E_SERVER_PORT ?? 3002);
const TEST_CLIENT_PORT = Number(process.env.E2E_CLIENT_PORT ?? 4176);

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.real\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  timeout: 300_000,
  use: {
    baseURL: `http://localhost:${TEST_CLIENT_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'node ../../scripts/e2e-server-real.cjs',
      port: TEST_SERVER_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'node ../../scripts/e2e-client.cjs',
      port: TEST_CLIENT_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});