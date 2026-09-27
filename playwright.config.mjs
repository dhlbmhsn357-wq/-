import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.E2E_PORT || 8799;

export default defineConfig({
  testDir: './tests/e2e/specs',
  fullyParallel: false,          // shared single-row backend → run serially for determinism
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0, // one retry for flaky infra only, never to hide bugs
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/e2e.json' }]] : 'list',
  timeout: 30000,
  expect: { timeout: 7000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'chromium-mobile', use: { ...devices['Pixel 5'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } }, // Safari-like (NOT real iOS)
  ],
  webServer: {
    command: 'node tests/e2e/server.mjs',
    url: `http://localhost:${PORT}/__ctl/db`,
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
    env: { E2E_PORT: String(PORT) },
  },
});
