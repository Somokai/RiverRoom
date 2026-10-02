import { defineConfig } from '@playwright/test';

// Browser fixtures must not inherit a real database or the interactive launcher's stdin lifetime.
for (const key of ['DATABASE_URL', 'HOST_KEY', 'RIVER_ROOM_PARENT_STDIN']) delete process.env[key];
const port = Number(process.env.TEST_PORT ?? 43187);
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './tests/browser',
  timeout: 120000,
  expect: { timeout: 15000 },
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run start:test',
    url: `${baseURL}/health/ready`,
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      PORT: String(port), HOST: '127.0.0.1', APP_ORIGIN: baseURL,
      DATA_DIR: ':memory:', NODE_ENV: 'development', DATABASE_SSL: 'false', TRUST_PROXY: '0',
    },
  },
});
