/**
 * E2E: generated code runs under upstream @playwright/test with no Studio
 * runtime dependency (acceptance criterion).
 * - PASS: the API-exported login spec runs green against the fixture app.
 * - Intentional FAIL: a mutated assertion fails, leaving screenshot + error +
 *   trace artifacts behind (acceptance: failure artifacts available).
 *
 * Skips gracefully when Chromium or the Studio API is unavailable.
 */
import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const PLAYWRIGHT_CLI = join(dirname(require.resolve('@playwright/test/package.json')), 'cli.js');

const API_BASE = process.env.STUDIO_API_URL ?? 'http://127.0.0.1:3101/api/v1';
const API_HEALTH = API_BASE.replace(/\/api\/v1$/, '') + '/health';
const USER = process.env.E2E_USER_ID ?? 'u_integration';
const FIXTURE_URL = process.env.FIXTURE_URL ?? 'http://127.0.0.1:3123';

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

test.beforeAll(async ({ request }) => {
  let ok = false;
  try {
    ok = (await request.get(API_HEALTH, { timeout: 5000 })).ok();
  } catch {
    ok = false;
  }
  test.skip(
    !ok,
    `Studio API is not reachable at ${API_HEALTH} — skipping E2E gracefully. ` +
      `Run via \`npx playwright test -c e2e/playwright.config.ts\` so webServer boots it.`,
  );
});

const UPSTREAM_CONFIG = `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'login.spec.ts',
  timeout: 30_000,
  outputDir: './output',
  use: { browserName: 'chromium', headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  reporter: [['list']],
});
`;

function findFiles(dir: string, ext: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findFiles(full, ext, out);
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

test('exported login spec passes under upstream @playwright/test', async ({ request }, testInfo) => {
  const stamp = Date.now();
  const project = (await (await request.post(`${API_BASE}/projects`, {
    headers: { 'x-user-id': USER }, data: { name: `e2e-compiled-${stamp}` },
  })).json()) as { id: string };

  const steps = [
    { id: 's1', type: 'goto', enabled: true, url: `${FIXTURE_URL}/fixture/login` },
    { id: 's2', type: 'fill', enabled: true, target: { primary: { strategy: 'label', value: 'Email' } }, value: 'tester@example.com' },
    {
      id: 's3', type: 'fill', enabled: true, target: { primary: { strategy: 'label', value: 'Password' } },
      value: '{{E2E_PASSWORD}}', sensitive: true,
    },
    { id: 's4', type: 'click', enabled: true, target: { primary: { strategy: 'role', role: 'button', name: 'Login' } } },
    { id: 's5', type: 'assertVisible', enabled: true, target: { primary: { strategy: 'text', value: 'Dashboard' } } },
  ];
  const created = (await (await request.post(`${API_BASE}/projects/${project.id}/tests`, {
    headers: { 'x-user-id': USER },
    data: {
      name: 'e2e compiled login',
      definitionJson: {
        schemaVersion: '1.0', id: `test_e2e_up_${stamp}`, projectId: project.id,
        name: 'e2e compiled login', browser: 'chromium', steps,
      },
    },
  })).json()) as { id: string };

  const exported = await request.get(`${API_BASE}/tests/${created.id}/export?format=spec`, {
    headers: { 'x-user-id': USER },
  });
  expect(exported.status()).toBe(200);
  const spec = await exported.text();
  expect(spec).toContain('@playwright/test');

  const workdir = testInfo.outputPath('upstream-pass');
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, 'login.spec.ts'), spec);
  writeFileSync(join(workdir, 'playwright.config.ts'), UPSTREAM_CONFIG);

  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [PLAYWRIGHT_CLI, 'test', `--config=${join(workdir, 'playwright.config.ts')}`], {
      cwd: workdir,
      env: { ...process.env, E2E_PASSWORD: 'e2e-secret-pw' },
      encoding: 'utf8',
      timeout: 90_000,
    });
  } catch (e) {
    const err = e as { stdout?: string; message: string };
    throw new Error(`upstream PASS run failed unexpectedly:\n${err.stdout ?? err.message}`);
  }
  expect(stdout).toContain('1 passed');
});

test('mutated spec fails with error + screenshot + trace artifacts', async ({ request }, testInfo) => {
  const stamp = Date.now() + 1;
  const project = (await (await request.post(`${API_BASE}/projects`, {
    headers: { 'x-user-id': USER }, data: { name: `e2e-compiled-fail-${stamp}` },
  })).json()) as { id: string };

  const steps = [
    { id: 's1', type: 'goto', enabled: true, url: `${FIXTURE_URL}/fixture/login` },
    { id: 's2', type: 'fill', enabled: true, target: { primary: { strategy: 'label', value: 'Email' } }, value: 'tester@example.com' },
    {
      id: 's3', type: 'fill', enabled: true, target: { primary: { strategy: 'label', value: 'Password' } },
      value: '{{E2E_PASSWORD}}', sensitive: true,
    },
    { id: 's4', type: 'click', enabled: true, target: { primary: { strategy: 'role', role: 'button', name: 'Login' } } },
    { id: 's5', type: 'assertVisible', enabled: true, target: { primary: { strategy: 'text', value: 'Dashboard' } } },
  ];
  const created = (await (await request.post(`${API_BASE}/projects/${project.id}/tests`, {
    headers: { 'x-user-id': USER },
    data: {
      name: 'e2e compiled fail',
      definitionJson: {
        schemaVersion: '1.0', id: `test_e2e_upf_${stamp}`, projectId: project.id,
        name: 'e2e compiled fail', browser: 'chromium', steps,
      },
    },
  })).json()) as { id: string };

  const exported = await request.get(`${API_BASE}/tests/${created.id}/export?format=spec`, {
    headers: { 'x-user-id': USER },
  });
  const spec = await exported.text();
  // Intentional failure: assert text that is not on the page.
  const mutated = spec.replace(
    'toBeVisible()',
    `toHaveText('Wrong text on purpose', { timeout: 2000 })`,
  );
  expect(mutated).not.toBe(spec);

  const workdir = testInfo.outputPath('upstream-fail');
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, 'login.spec.ts'), mutated);
  writeFileSync(join(workdir, 'playwright.config.ts'), UPSTREAM_CONFIG);

  let stdout = '';
  let exit = 0;
  try {
    stdout = execFileSync(process.execPath, [PLAYWRIGHT_CLI, 'test', `--config=${join(workdir, 'playwright.config.ts')}`], {
      cwd: workdir,
      env: { ...process.env, E2E_PASSWORD: 'e2e-secret-pw' },
      encoding: 'utf8',
      timeout: 90_000,
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    exit = err.status ?? 1;
    stdout = err.stdout ?? '';
  }
  expect(exit, `mutated spec must fail;\n${stdout}`).not.toBe(0);
  expect(stdout).toContain('Wrong text on purpose');

  const traces = findFiles(join(workdir, 'output'), '.zip');
  const shots = findFiles(join(workdir, 'output'), '.png');
  expect(traces.length, `trace.zip must be retained (found in output/):\n${stdout}`).toBeGreaterThan(0);
  expect(shots.length, 'failure screenshot must be captured').toBeGreaterThan(0);
  expect(statSync(traces[0]).size).toBeGreaterThan(0);

  // Keep evidence visible in the report.
  await testInfo.attach('upstream-failure-output', { body: stdout.slice(0, 4000), contentType: 'text/plain' });
});
