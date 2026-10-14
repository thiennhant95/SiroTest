/**
 * QC smoke (tester eyes): the full tester flow through the real UI.
 *
 * Seeds one project + env + one deterministically-FAILING test via the API
 * (setup only — everything a tester would do goes through the browser),
 * then: dev login → builder → select env → Run → failed result → Explain →
 * step detail → audit. Cleans up the scratch project afterwards.
 *
 * Regression net for three bugs API gates could not see:
 *  1. raw ANSI escapes (`[2m`) rendered in the failure alert;
 *  2. absolute server paths (`C:\…Temp\pw-studio-runs…`) in call logs;
 *  3. failed steps rendering "This step passed" / "no longer in the
 *     current definition" (wrong field name + unparsed definitionJson).
 *
 * Run: npx playwright test -c e2e/qc.config.ts
 * Needs: fixture + API + web booted by qc.config.ts webServer.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

const API_BASE = process.env.STUDIO_API_URL ?? 'http://127.0.0.1:3101/api/v1';
const FIXTURE_URL = process.env.FIXTURE_URL ?? 'http://127.0.0.1:3123';
const USER = `u_qc_smoke_${Date.now().toString(36)}`;

function api(request: APIRequestContext) {
  const headers = { 'x-user-id': USER };
  return {
    post: (url: string, data?: unknown) => request.post(`${API_BASE}${url}`, { headers, data }),
    get: (url: string) => request.get(`${API_BASE}${url}`, { headers }),
    delete: (url: string) => request.delete(`${API_BASE}${url}`, { headers }),
  };
}

async function devLogin(page: Page) {
  await page.goto('/login');
  await page.getByRole('tab', { name: 'Dev' }).click();
  await page.getByPlaceholder('tester-1').fill(USER);
  await page.getByRole('button', { name: /log in \(dev\)/i }).click();
  await page.waitForURL('**/projects', { timeout: 15_000 });
}

test('qc smoke: tester flow shows clean failures, working explain + audit', async ({ page, request }) => {
  test.slow();
  // Tours auto-open on first visit and their overlay covers the Run button —
  // mark them done (a tester sees them once; the smoke asserts the app).
  await page.addInitScript(() => {
    localStorage.setItem('vv-tour-builder-v2', 'done');
    localStorage.setItem('vv-tour-run-v2', 'done');
    localStorage.setItem('vv-tour-run-done', 'done');
  });
  const a = api(request);
  const stamp = Date.now().toString(36);

  // --- Seed (setup only): project + env + one deterministically failing test.
  const project = (await (await a.post('/projects', { name: `qc-smoke-${stamp}` })).json()) as { id: string };
  const env = (await (
    await a.post(`/projects/${project.id}/environments`, { name: 'qc-env', baseUrl: FIXTURE_URL })
  ).json()) as { id: string };
  const created = (await (
    await a.post(`/projects/${project.id}/tests`, {
      name: 'qc failing login check',
      definitionJson: {
        schemaVersion: '1.0', name: 'qc failing login check', browser: 'chromium',
        steps: [
          { id: 's1', type: 'goto', enabled: true, url: `${FIXTURE_URL}/fixture/login` },
          {
            id: 's2', type: 'assertVisible', enabled: true,
            target: { primary: { strategy: 'text', value: 'text-that-does-not-exist-qc' } },
          },
        ],
      },
    })
  ).json()) as { id: string };

  try {
    // --- 1. Real UI login (dev mode, as a pilot tester would).
    await devLogin(page);
    await expect(page.getByRole('link', { name: new RegExp(`qc-smoke-${stamp}`) })).toBeVisible();

    // --- 2. Builder renders the seeded steps (Japanese-proof unicode included).
    await page.goto(`/tests/${created.id}`);
    await expect(page.getByText('text-that-does-not-exist-qc').first()).toBeVisible({ timeout: 20_000 });

    // --- 3. Run from the builder UI (env select is mandatory — no default).
    await page.locator('select').first().selectOption({ label: 'qc-env' });
    await page.getByRole('button', { name: 'Run' }).click();
    await page.getByRole('button', { name: 'Start run' }).click();
    await page.waitForURL('**/runs/**', { timeout: 30_000 });

    // --- 4. Failed result: error text must be human-readable.
    const alert = page.locator('[role=alert]').first();
    await expect(alert).toContainText(/failed/i, { timeout: 120_000 });
    const alertText = (await alert.innerText()).slice(0, 3000);
    expect(alertText, 'no raw ANSI escapes in failure alert').not.toMatch(/\[\d+m/);
    expect(alertText, 'no ESC bytes in failure alert').not.toContain('');
    expect(alertText, 'no Windows server paths in failure alert').not.toMatch(/[A-Za-z]:\\/);
    expect(alertText, 'no temp workdir leak in failure alert').not.toContain('pw-studio-runs');

    // --- 5. Failed step detail: real error rows, never "This step passed".
    const failedStep = page.locator('details.step-failed').first();
    await expect(failedStep).toBeVisible();
    await expect(failedStep).toContainText('Short error:');
    await expect(failedStep).toContainText('Locator:');
    await expect(failedStep).not.toContainText('This step passed');
    await expect(failedStep).not.toContainText('no longer in the current definition');

    // --- 6. One-click Explain renders an honest engine badge + explanation.
    await page.getByTestId('explain-btn').click();
    const explain = page.getByTestId('explain-with-ai');
    await expect(explain).toContainText(/engine: (rules|llm)/, { timeout: 60_000 });
    await expect(explain).not.toContainText('Could not explain');

    // --- 7. Audit page shows the trail for this project.
    await page.goto(`/projects/${project.id}/audit`);
    await expect(page.getByText('project.create').first()).toBeVisible({ timeout: 20_000 });
  } finally {
    // --- Cleanup: scratch project (audited delete, like any tester would).
    await a.delete(`/projects/${project.id}`).catch(() => undefined);
  }
});
