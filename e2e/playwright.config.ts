/**
 * Playwright config for Day 8-10 E2E (12-testing/test-strategy.md).
 * - Chromium only, headed=false (release gate P0: core E2E green on Chromium).
 * - webServer boots the fixture target + the real Studio API (isolated SQLite).
 * - trace/screenshot retained on failure so the intentional-failure spec can
 *   assert failure artifacts.
 */
import { defineConfig } from '@playwright/test';

const FIXTURE_PORT = Number(process.env.FIXTURE_PORT ?? 3123);
const API_PORT = Number(process.env.API_PORT ?? 3101);

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${FIXTURE_PORT}`,
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command: 'npx tsx servers/fixture-server.ts',
      url: `http://127.0.0.1:${FIXTURE_PORT}/fixture/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'npx tsx servers/api-server.ts',
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
