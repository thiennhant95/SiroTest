/**
 * QC smoke config: the tester-eye gate (see e2e/qc-smoke.spec.ts).
 *
 * Boots the SAME isolated stack as the P0 e2e config (fixture app + Studio
 * API on the integration DB) PLUS the real Studio web UI, then drives the
 * full tester flow through the browser: dev login → builder → run → failed
 * result → Explain → step detail → audit.
 *
 * API regression suites assert status codes; they CANNOT see leaked ANSI
 * escapes, raw server paths, or wrong empty-state copy — this spec exists
 * because three such bugs shipped while every API gate was green.
 *
 * Run: npx playwright test -c e2e/qc.config.ts
 * (Does NOT run under e2e/playwright.config.ts — the P0 gate stays untouched.)
 */
import { defineConfig } from '@playwright/test';

const FIXTURE_PORT = Number(process.env.FIXTURE_PORT ?? 3123);
const API_PORT = Number(process.env.API_PORT ?? 3101);
const WEB_PORT = Number(process.env.QC_WEB_PORT ?? 5174);

export default defineConfig({
  testDir: '.',
  testMatch: 'qc-smoke.spec.ts',
  timeout: 300_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
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
    {
      command: 'npx vite --port 5174 --strictPort',
      cwd: '../apps/web',
      url: `http://127.0.0.1:${WEB_PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...process.env,
        VV_API_PROXY: `http://127.0.0.1:${API_PORT}`,
      } as Record<string, string>,
    },
  ],
});
