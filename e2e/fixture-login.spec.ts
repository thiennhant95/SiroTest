/**
 * E2E: the fixture target app behaves like examples/login-test.json expects.
 * - PASS: record-equivalent steps (goto/fill/fill/click) reach Dashboard.
 * - Intentional failure: a wrong-text assertion produces an error, and the
 *   test captures screenshot + trace artifacts explicitly (acceptance:
 *   "On failure, screenshot + error are available; trace is available when
 *   tracing is enabled").
 *
 * If Chromium is not installed the whole file skips gracefully with a clear
 * message instead of failing.
 */
import { test, expect, chromium, type Page } from '@playwright/test';
import { existsSync, statSync } from 'node:fs';

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

test.skip(
  !hasChromium,
  'Chromium browser is not installed — skipping E2E gracefully. ' +
    'Install it with `npx playwright install chromium` and re-run.',
);

// Playwright-level tracing is driven manually in the artifact test below
// (config `trace: retain-on-failure` would otherwise auto-start it and
// `tracing.start()` would throw "already started").
test.use({ trace: 'off', screenshot: 'off' });

async function login(page: Page, password = 'fixture-secret') {
  await page.goto('/fixture/login');
  await page.getByLabel('Email').fill('tester@example.com');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Login' }).click();
}

test('login fixture: valid credentials reach Dashboard', async ({ page }) => {
  await login(page);
  await expect(page.getByText('Dashboard')).toBeVisible();
  await expect(page).toHaveURL(/#\/dashboard/);
  await expect(page.getByText('Welcome, tester@example.com!')).toBeVisible();
});

test('login fixture: empty credentials stay on login with an error', async ({ page }) => {
  await page.goto('/fixture/login');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByText('Email and password are required.')).toBeVisible();
  await expect(page.getByText('Dashboard')).toBeHidden();
});

test('intentional wrong-text assertion yields error + screenshot + trace', async ({ browser }, testInfo) => {
  // Own context with Playwright-level tracing off so we can drive tracing
  // manually and assert the artifacts inside a (green) test.
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await context.tracing.start({ screenshots: true, snapshots: true });
    await login(page);
    await expect(page.getByText('Dashboard')).toBeVisible();

    let error: string | null = null;
    try {
      await expect(page.getByText('Dashboard')).toHaveText('Wrong text on purpose', { timeout: 2000 });
    } catch (e) {
      error = (e as Error).message;
    }
    expect(error, 'the wrong-text assertion must fail with an error').not.toBeNull();
    expect(error!).toContain('Wrong text on purpose');

    const screenshotPath = testInfo.outputPath('failure.png');
    await page.screenshot({ path: screenshotPath });
    const tracePath = testInfo.outputPath('trace.zip');
    await context.tracing.stop({ path: tracePath });

    expect(statSync(screenshotPath).size, 'screenshot artifact must exist').toBeGreaterThan(0);
    expect(statSync(tracePath).size, 'trace artifact must exist when tracing is on').toBeGreaterThan(0);
    await testInfo.attach('failure-screenshot', { path: screenshotPath, contentType: 'image/png' });
    await testInfo.attach('failure-trace', { path: tracePath, contentType: 'application/zip' });
  } finally {
    await context.close();
  }
});
