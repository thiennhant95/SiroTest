/**
 * Integration: API CRUD + versioning + run lifecycle + compiler + redaction.
 * Strategy: 12-testing/test-strategy.md (Integration: API CRUD/versioning).
 * Runs against a real Fastify app + isolated SQLite file (never dev.db).
 *
 * Run: npx tsx --test tests/integration/api-crud-versioning.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import {
  ensureIntegrationDb,
  injectJson,
  loginFixtureDefinition,
} from './helpers.js';

// The server module auto-listens unless SKIP_LISTEN=1 (see apps/server/src/app.ts).
// Set it BEFORE the server module is evaluated -> dynamic import.
process.env.SKIP_LISTEN = '1';
const { buildApp } = await import('../../apps/server/src/app.js');

type App = FastifyInstance;
let app: App;
const wsEvents: Array<{ event: string; payload: unknown }> = [];
let prevBroadcast: unknown;

before(async () => {
  await ensureIntegrationDb();
  app = await buildApp();
  // Capture WS broadcasts (run.queued / run.cancelled / recorder.*).
  prevBroadcast = (globalThis as Record<string, unknown>).__vvWsBroadcast;
  (globalThis as Record<string, unknown>).__vvWsBroadcast = (event: string, payload: unknown) => {
    wsEvents.push({ event, payload });
  };
});

after(async () => {
  (globalThis as Record<string, unknown>).__vvWsBroadcast = prevBroadcast;
  await app.close();
});

function payloadOf(event: string): unknown[] {
  return wsEvents.filter((e) => e.event === event).map((e) => e.payload);
}

describe('fixture target app', () => {
  it('serves the tiny login app without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/fixture/login' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /text\/html/);
    assert.match(res.body, /id="login-form"/);
    assert.match(res.body, /<label for="email">Email<\/label>/);
    assert.match(res.body, /Dashboard/);
  });

  it('fixture health is ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/fixture/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, fixture: 'login' });
  });
});

describe('projects CRUD', () => {
  it('creates, reads, updates, lists and deletes a project', async () => {
    const created = await injectJson(app, 'POST', '/api/v1/projects', { name: 'api-proj' });
    assert.equal(created.statusCode, 201);
    const project = created.json() as { id: string; name: string };
    assert.ok(project.id);

    const got = await injectJson(app, 'GET', `/api/v1/projects/${project.id}`);
    assert.equal(got.statusCode, 200);

    const patched = await injectJson(app, 'PATCH', `/api/v1/projects/${project.id}`, {
      description: 'day8',
    });
    assert.equal(patched.statusCode, 200);
    assert.equal((patched.json() as { description: string }).description, 'day8');

    const listed = await injectJson(app, 'GET', '/api/v1/projects');
    assert.equal(listed.statusCode, 200);
    assert.ok((listed.json() as unknown[]).some((p) => (p as { id: string }).id === project.id));

    const deleted = await injectJson(app, 'DELETE', `/api/v1/projects/${project.id}`);
    assert.equal(deleted.statusCode, 204);

    const gone = await injectJson(app, 'GET', `/api/v1/projects/${project.id}`);
    assert.equal(gone.statusCode, 404);
    assert.equal((gone.json() as { code: string }).code, 'NOT_FOUND');
  });

  it('rejects invalid payloads with VALIDATION_ERROR', async () => {
    const res = await injectJson(app, 'POST', '/api/v1/projects', {});
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { code: string }).code, 'VALIDATION_ERROR');
  });

  it('stray content-type with empty body maps to 400, never 500', async () => {
    const created = await injectJson(app, 'POST', '/api/v1/projects', { name: 'api-empty-body' });
    const { id } = created.json() as { id: string };
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${id}`,
      headers: { 'content-type': 'application/json', 'x-user-id': 'u_integration' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { code: string }).code, 'VALIDATION_ERROR');
  });
});

describe('tests CRUD + immutable versioning', () => {
  async function makeProject(): Promise<string> {
    const res = await injectJson(app, 'POST', '/api/v1/projects', { name: 'api-ver-proj' });
    return (res.json() as { id: string }).id;
  }

  it(' meaningful save creates a new version; restore appends, never deletes', async () => {
    const projectId = await makeProject();
    const v1 = {
      ...loginFixtureDefinition(projectId, 'http://127.0.0.1:3123'),
      steps: loginFixtureDefinition(projectId, 'http://127.0.0.1:3123').steps.slice(0, 2),
    };
    const created = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
      name: 'versioned login',
      definitionJson: v1,
    });
    assert.equal(created.statusCode, 201);
    const test = created.json() as { id: string };
    assert.ok(test.id);

    const v2 = {
      ...v1,
      steps: [...v1.steps, { id: 's9', type: 'reload', enabled: true }],
    };
    const patched = await injectJson(app, 'PATCH', `/api/v1/tests/${test.id}`, {
      definitionJson: v2,
      changeMessage: 'add reload',
    });
    assert.equal(patched.statusCode, 200);

    const versionsRes = await injectJson(app, 'GET', `/api/v1/tests/${test.id}/versions`);
    assert.equal(versionsRes.statusCode, 200);
    const versions = versionsRes.json() as Array<{ id: string; versionNumber: number; definitionJson: string }>;
    assert.deepEqual(versions.map((v) => v.versionNumber), [2, 1]);
    const v1row = versions.find((v) => v.versionNumber === 1)!;
    assert.equal(JSON.parse(v1row.definitionJson).steps.length, 2);

    // Restore v1 -> creates v3 carrying v1 content; history is never deleted.
    const restored = await injectJson(
      app, 'POST', `/api/v1/tests/${test.id}/versions/${v1row.id}/restore`,
    );
    assert.equal(restored.statusCode, 200);
    assert.equal((restored.json() as { versionNumber: number }).versionNumber, 3);

    const after = (await injectJson(app, 'GET', `/api/v1/tests/${test.id}/versions`)).json() as Array<{
      versionNumber: number; definitionJson: string;
    }>;
    assert.deepEqual(after.map((v) => v.versionNumber), [3, 2, 1]);
    assert.equal(JSON.parse(after[0].definitionJson).steps.length, 2);

    // Duplicate + delete flow.
    const dup = await injectJson(app, 'POST', `/api/v1/tests/${test.id}/duplicate`);
    assert.equal(dup.statusCode, 201);
    assert.match((dup.json() as { name: string }).name, /\(copy\)/);
    const del = await injectJson(app, 'DELETE', `/api/v1/tests/${test.id}`);
    assert.equal(del.statusCode, 204);
  });
});

describe('runs lifecycle (API half)', () => {
  it('queues a run, streams run.queued, then cancels it', async () => {
    const project = (await injectJson(app, 'POST', '/api/v1/projects', { name: 'api-run-proj' })).json() as { id: string };
    const env = (await injectJson(app, 'POST', `/api/v1/projects/${project.id}/environments`, {
      name: 'int-env', baseUrl: 'http://127.0.0.1:3123',
    })).json() as { id: string };
    const test = (await injectJson(app, 'POST', `/api/v1/projects/${project.id}/tests`, {
      name: 'runnable',
      definitionJson: loginFixtureDefinition(project.id, 'http://127.0.0.1:3123'),
    })).json() as { id: string };

    wsEvents.length = 0;
    const runRes = await injectJson(app, 'POST', `/api/v1/tests/${test.id}/runs`, {
      environmentId: env.id, browser: 'chromium',
    });
    assert.equal(runRes.statusCode, 202);
    const run = runRes.json() as { id: string; status: string };
    assert.equal(run.status, 'queued');
    const queued = payloadOf('run.queued');
    assert.equal(queued.length, 1);
    assert.equal((queued[0] as { runId: string }).runId, run.id);

    const listed = await injectJson(app, 'GET', `/api/v1/tests/${test.id}/runs`);
    assert.equal(listed.statusCode, 200);
    assert.ok(((listed.json() as unknown[]).length) >= 1);

    const detail = await injectJson(app, 'GET', `/api/v1/runs/${run.id}`);
    assert.equal(detail.statusCode, 200);

    const cancelled = await injectJson(app, 'POST', `/api/v1/runs/${run.id}/cancel`);
    assert.equal(cancelled.statusCode, 200);
    assert.equal((cancelled.json() as { status: string }).status, 'cancelled');
    assert.equal(payloadOf('run.cancelled').length, 1);

    const again = await injectJson(app, 'POST', `/api/v1/runs/${run.id}/cancel`);
    assert.equal(again.statusCode, 409);
    assert.equal((again.json() as { code: string }).code, 'RUN_NOT_CANCELLABLE');
  });

  it('rejects runs against foreign environments', async () => {
    const p1 = ((await injectJson(app, 'POST', '/api/v1/projects', { name: 'api-run-a' })).json() as { id: string }).id;
    const p2 = ((await injectJson(app, 'POST', '/api/v1/projects', { name: 'api-run-b' })).json() as { id: string }).id;
    const envB = ((await injectJson(app, 'POST', `/api/v1/projects/${p2}/environments`, { name: 'b-env' })).json() as { id: string }).id;
    const testA = ((await injectJson(app, 'POST', `/api/v1/projects/${p1}/tests`, { name: 't' })).json() as { id: string }).id;
    const res = await injectJson(app, 'POST', `/api/v1/tests/${testA}/runs`, { environmentId: envB });
    assert.equal(res.statusCode, 400);
  });
});

describe('compiler endpoints', () => {
  it('compiles the login definition and exports a spec', async () => {
    const projectId = ((await injectJson(app, 'POST', '/api/v1/projects', { name: 'api-comp-proj' })).json() as { id: string }).id;
    const def = {
      ...loginFixtureDefinition(projectId, '{{BASE_URL}}'),
      steps: [
        { id: 's1', type: 'goto', enabled: true, url: '{{BASE_URL}}/fixture/login' },
        { id: 's2', type: 'fill', enabled: true, target: { primary: { strategy: 'label', value: 'Email' } }, value: '{{ADMIN_EMAIL}}' },
        {
          id: 's3', type: 'fill', enabled: true, target: { primary: { strategy: 'label', value: 'Password' } },
          value: '{{ADMIN_PASSWORD}}', sensitive: true,
        },
        { id: 's4', type: 'click', enabled: true, target: { primary: { strategy: 'role', role: 'button', name: 'Login' } } },
        { id: 's5', type: 'assertVisible', enabled: true, target: { primary: { strategy: 'text', value: 'Dashboard' } } },
      ],
    };
    const testId = ((await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
      name: 'compilable', definitionJson: def,
    })).json() as { id: string }).id;

    const compiled = await injectJson(app, 'POST', `/api/v1/tests/${testId}/compile`);
    assert.equal(compiled.statusCode, 200);
    const code = (compiled.json() as { code: string }).code;
    assert.match(code, /getByLabel\('Email'\)/);
    assert.match(code, /getByRole\('button', \{ name: 'Login' \}\)/);
    // Server preview compiler emits bracket lookups; the full compiler emits
    // `process.env.NAME!` — both are runtime lookups, never inlined secrets.
    assert.match(code, /process\.env(\.ADMIN_PASSWORD|\['ADMIN_PASSWORD'\])/);
    assert.match(code, /toBeVisible/);

    const exported = await injectJson(app, 'GET', `/api/v1/tests/${testId}/export?format=spec`);
    assert.equal(exported.statusCode, 200);
    assert.match(exported.headers['content-disposition'] as string, /\.spec\.ts/);
    assert.match(exported.body, /@playwright\/test/);

    const badFormat = await injectJson(app, 'GET', `/api/v1/tests/${testId}/export?format=pdf`);
    assert.equal(badFormat.statusCode, 400);

    // Unknown steps are rejected at persist time (fail fast, never stored).
    const badPatch = await injectJson(app, 'PATCH', `/api/v1/tests/${testId}`, {
      definitionJson: { ...def, steps: [...def.steps, { id: 'sx', type: 'dragAndDrop', enabled: true }] },
    });
    assert.equal(badPatch.statusCode, 422);
    assert.equal((badPatch.json() as { code: string }).code, 'COMPILER_UNSUPPORTED_STEP');
  });
});

describe('variables + secret redaction', () => {
  it('never returns secret plaintext after creation', async () => {
    const projectId = ((await injectJson(app, 'POST', '/api/v1/projects', { name: 'api-var-proj' })).json() as { id: string }).id;
    const created = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/variables`, {
      key: 'ADMIN_PASSWORD', value: 's3cr3t-pw-zzz', isSecret: true,
    });
    assert.equal(created.statusCode, 201);
    const row = created.json() as Record<string, unknown>;
    assert.equal(row['value'], null);
    assert.equal(row['hasValue'], true);
    assert.ok(!('valueEncrypted' in row), 'ciphertext must not leak either');

    const listed = ((await injectJson(app, 'GET', `/api/v1/projects/${projectId}/variables`)).json() as Array<Record<string, unknown>>);
    const secret = listed.find((v) => v['key'] === 'ADMIN_PASSWORD')!;
    assert.equal(secret['value'], null);

    const plain = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/variables`, {
      key: 'ADMIN_EMAIL', value: 'tester@example.com',
    });
    assert.equal((plain.json() as Record<string, unknown>)['value'], 'tester@example.com');

    // Compiled code references the secret by name; stored plaintext never inlines.
    const testId = ((await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
      name: 'secret login',
      definitionJson: {
        ...loginFixtureDefinition(projectId, '{{BASE_URL}}'),
        steps: [
          { id: 's1', type: 'goto', enabled: true, url: '{{BASE_URL}}/fixture/login' },
          {
            id: 's2', type: 'fill', enabled: true,
            target: { primary: { strategy: 'label', value: 'Password' } },
            value: '{{ADMIN_PASSWORD}}', sensitive: true,
          },
        ],
      },
    })).json() as { id: string }).id;
    const code = ((await injectJson(app, 'POST', `/api/v1/tests/${testId}/compile`)).json() as { code: string }).code;
    assert.match(code, /process\.env(\.ADMIN_PASSWORD|\['ADMIN_PASSWORD'\])/);
    assert.ok(!code.includes('s3cr3t-pw-zzz'), 'secret plaintext must never appear in generated code');
  });
});

describe('recorder API', () => {
  async function makeTest(name: string): Promise<{ projectId: string; testId: string }> {
    const projectId = ((await injectJson(app, 'POST', '/api/v1/projects', { name: `api-rec-${name}` })).json() as { id: string }).id;
    const testId = ((await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
      name,
      definitionJson: loginFixtureDefinition(projectId, 'http://127.0.0.1:3123'),
    })).json() as { id: string }).id;
    return { projectId, testId };
  }

  it('start -> assertion -> stop persists draft steps into the definition', async () => {
    const { testId } = await makeTest('persist');
    const started = await injectJson(app, 'POST', `/api/v1/tests/${testId}/recorder/start`, {});
    assert.equal(started.statusCode, 201);
    const { sessionId } = started.json() as { sessionId: string };
    assert.ok(sessionId);

    const second = await injectJson(app, 'POST', `/api/v1/tests/${testId}/recorder/start`, {});
    assert.equal(second.statusCode, 409);
    assert.equal((second.json() as { code: string }).code, 'CONFLICT_RECORDER_ACTIVE');

    const probed = await injectJson(app, 'POST', `/api/v1/recorder/${sessionId}/locator/test`, {
      candidate: { strategy: 'label', value: 'Email' },
    });
    assert.equal(probed.statusCode, 200);
    assert.equal((probed.json() as { matches: number }).matches, 1);
    assert.equal((probed.json() as { healthy: boolean }).healthy, true);

    const assertion = await injectJson(app, 'POST', `/api/v1/recorder/${sessionId}/assertion`, {
      type: 'assertVisible',
      target: { primary: { strategy: 'text', value: 'Dashboard' } },
    });
    assert.equal(assertion.statusCode, 201);

    const stopped = await injectJson(app, 'POST', `/api/v1/recorder/${sessionId}/stop`);
    assert.equal(stopped.statusCode, 200);
    assert.ok(((stopped.json() as { draftCount: number }).draftCount) >= 1);

    const testRow = (await injectJson(app, 'GET', `/api/v1/tests/${testId}`)).json() as { definitionJson: string };
    const steps = (JSON.parse(testRow.definitionJson) as { steps: unknown[] }).steps;
    assert.equal(steps.length, 5 + 1, 'recorded assertion must be appended to the definition');
  });

  it('pause buffers, resume replays, stopped sessions are gone', async () => {
    const { testId } = await makeTest('pause');
    const { sessionId } = (await injectJson(app, 'POST', `/api/v1/tests/${testId}/recorder/start`, {})).json() as { sessionId: string };
    const paused = await injectJson(app, 'POST', `/api/v1/recorder/${sessionId}/pause`);
    assert.equal(paused.statusCode, 200);
    assert.equal((paused.json() as { status: string }).status, 'paused');
    const resumed = await injectJson(app, 'POST', `/api/v1/recorder/${sessionId}/resume`);
    assert.equal((resumed.json() as { status: string }).status, 'active');
    await injectJson(app, 'POST', `/api/v1/recorder/${sessionId}/stop`);
    const afterStop = await injectJson(app, 'POST', `/api/v1/recorder/${sessionId}/pause`);
    assert.equal(afterStop.statusCode, 404);
  });
});
