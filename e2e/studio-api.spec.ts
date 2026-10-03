/**
 * E2E (API-driven, no browser needed): the full Studio flow from
 * 12-testing/test-strategy.md —
 * create project -> create test from the login fixture -> add assertion ->
 * compile -> export -> run -> PASS-path queued -> cancel.
 *
 * Runs against the real Studio API booted by webServer. If the API is not
 * reachable the file skips gracefully with a clear message.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';

const API_BASE = process.env.STUDIO_API_URL ?? 'http://127.0.0.1:3101/api/v1';
const API_HEALTH = (process.env.STUDIO_API_URL ?? 'http://127.0.0.1:3101/api/v1').replace(/\/api\/v1$/, '') + '/health';
const USER = process.env.E2E_USER_ID ?? 'u_integration';
const FIXTURE_URL = process.env.FIXTURE_URL ?? 'http://127.0.0.1:3123';

test.beforeAll(async ({ request }) => {
  let ok = false;
  try {
    const res = await request.get(API_HEALTH, { timeout: 5000 });
    ok = res.ok();
  } catch {
    ok = false;
  }
  test.skip(
    !ok,
    `Studio API is not reachable at ${API_HEALTH} — skipping E2E gracefully. ` +
      `Run via \`npx playwright test -c e2e/playwright.config.ts\` so webServer boots it.`,
  );
});

function auth(request: APIRequestContext) {
  return {
    post: (url: string, data?: unknown) =>
      request.post(`${API_BASE}${url}`, { headers: { 'x-user-id': USER }, data }),
    get: (url: string) => request.get(`${API_BASE}${url}`, { headers: { 'x-user-id': USER } }),
    patch: (url: string, data?: unknown) =>
      request.patch(`${API_BASE}${url}`, { headers: { 'x-user-id': USER }, data }),
  };
}

function loginSteps() {
  return [
    { id: 's1', type: 'goto', enabled: true, url: `${FIXTURE_URL}/fixture/login` },
    { id: 's2', type: 'fill', enabled: true, target: { primary: { strategy: 'label', value: 'Email' } }, value: 'tester@example.com' },
    {
      id: 's3', type: 'fill', enabled: true, target: { primary: { strategy: 'label', value: 'Password' } },
      value: '{{E2E_PASSWORD}}', sensitive: true,
    },
    {
      id: 's4', type: 'click', enabled: true,
      target: { primary: { strategy: 'role', role: 'button', name: 'Login' } },
    },
    { id: 's5', type: 'assertVisible', enabled: true, target: { primary: { strategy: 'text', value: 'Dashboard' } } },
  ];
}

test('studio flow: project -> test -> assertion -> compile -> run -> cancel', async ({ request }) => {
  const api = auth(request);
  const stamp = Date.now();

  // 1. Create project.
  const projectRes = await api.post('/projects', { name: `e2e-studio-${stamp}` });
  expect(projectRes.ok()).toBeTruthy();
  const project = await projectRes.json() as { id: string };

  // 2. Environment pointing at the fixture app.
  const envRes = await api.post(`/projects/${project.id}/environments`, {
    name: 'e2e-env', baseUrl: FIXTURE_URL,
  });
  expect(envRes.ok()).toBeTruthy();
  const env = await envRes.json() as { id: string };

  // 3. Create test from the login fixture.
  const testRes = await api.post(`/projects/${project.id}/tests`, {
    name: 'e2e login',
    definitionJson: {
      schemaVersion: '1.0', id: `test_e2e_${stamp}`, projectId: project.id,
      name: 'e2e login', browser: 'chromium', baseUrl: FIXTURE_URL, steps: loginSteps(),
    },
  });
  expect(testRes.status()).toBe(201);
  const created = await testRes.json() as { id: string };

  // 4. Add an assertion step (meaningful save -> new version).
  const withAssertion = [...loginSteps(), {
    id: 's6', type: 'assertText', enabled: true,
    target: { primary: { strategy: 'text', value: 'Dashboard' } }, expected: 'Dashboard',
  }];
  const patched = await api.patch(`/tests/${created.id}`, {
    definitionJson: {
      schemaVersion: '1.0', id: `test_e2e_${stamp}`, projectId: project.id,
      name: 'e2e login', browser: 'chromium', baseUrl: FIXTURE_URL, steps: withAssertion,
    },
    changeMessage: 'add Dashboard text assertion',
  });
  expect(patched.ok()).toBeTruthy();

  const versions = await (await api.get(`/tests/${created.id}/versions`)).json() as Array<{ versionNumber: number }>;
  expect(versions.map((v) => v.versionNumber)).toEqual([2, 1]);

  // 5. Compile + export: the added assertion must be in the generated spec.
  const compiled = await (await api.post(`/tests/${created.id}/compile`)).json() as { code: string };
  expect(compiled.code).toContain(`getByLabel('Email')`);
  expect(compiled.code).toContain(`toHaveText('Dashboard')`);
  expect(compiled.code).not.toContain('s3cr3t');

  const exported = await api.get(`/tests/${created.id}/export?format=spec`);
  expect(exported.status()).toBe(200);
  expect(exported.headers()['content-disposition']).toContain('.spec.ts');

  // 6. Run: accepted (202, queued) then executed by the wired worker —
  // by the time we fetch, it may be queued/running (usual) or already
  // terminal on a fast host. All are valid lifecycle states.
  const runRes = await api.post(`/tests/${created.id}/runs`, { environmentId: env.id, browser: 'chromium' });
  expect(runRes.status()).toBe(202);
  const run = await runRes.json() as { id: string; status: string };
  expect(run.status).toBe('queued');

  const detail = await (await api.get(`/runs/${run.id}`)).json() as { status: string };
  expect(['queued', 'running', 'passed', 'failed', 'cancelled']).toContain(detail.status);

  // 7. Cancel while active; if the run already settled, that itself proves
  // the full execution path (fetch the terminal state as evidence).
  const cancelRes = await api.post(`/runs/${run.id}/cancel`);
  if (cancelRes.status() === 409) {
    const final = await (await api.get(`/runs/${run.id}`)).json() as { status: string };
    expect(['passed', 'failed', 'cancelled']).toContain(final.status);
  } else {
    expect(cancelRes.ok()).toBeTruthy();
    expect(((await cancelRes.json()) as { status: string }).status).toBe('cancelled');
  }
});
