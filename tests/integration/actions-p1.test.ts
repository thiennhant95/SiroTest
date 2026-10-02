/**
 * Integration: P1 reusable actions + parameters (backlog 15-tasks).
 * Strategy: 12-testing/test-strategy.md (Integration: API CRUD + runner
 * lifecycle with the stub Playwright CLI — no browser required).
 *
 * Covers:
 * - Actions CRUD (GET/POST /projects/:id/actions, GET/PATCH/DELETE
 *   /actions/:aid) + validation (nested callAction, dup names/params,
 *   unknown step types, name conflicts, delete-guard when referenced).
 * - A test definition carrying `callAction` stores fine (server allowlist),
 *   compiles with the callee inlined (POST /tests/:id/compile + export),
 *   and runs end-to-end via the runner (stub CLI) without breaking.
 * - Runner parity: validate accepts callAction; compileSpec inlines like the
 *   canonical package (outer [id] title, secret -> env lookup, explicit
 *   failures for unknown action / missing arg / plaintext secret).
 *
 * Run: npx tsx --test tests/integration/actions-p1.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import {
  ensureIntegrationDb,
  injectJson,
} from './helpers.js';
import { runTest } from '../../apps/runner/src/run.js';
import { InMemoryRunStore } from '../../apps/runner/src/persist.js';
import type { RunEvent } from '../../apps/runner/src/events.js';
import { compileSpec, CompileError } from '../../apps/runner/src/compile.js';
import { validateTestDefinition, ValidationError } from '../../apps/runner/src/validate.js';
import type { RunRequest } from '../../apps/runner/src/types.js';

// The server module auto-listens unless SKIP_LISTEN=1 (see apps/server/src/app.ts).
process.env.SKIP_LISTEN = '1';
const { buildApp } = await import('../../apps/server/src/app.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, 'stub-playwright.mjs');
const SECRET = 's3cr3t-action-pw';
const FIXTURE_URL = 'http://127.0.0.1:3123';

let app: FastifyInstance;
let storageRoot: string;
let prevStorageRoot: string | undefined;
let prevBroadcast: unknown;

before(async () => {
  await ensureIntegrationDb();
  app = await buildApp();
  prevBroadcast = (globalThis as Record<string, unknown>).__vvWsBroadcast;
  (globalThis as Record<string, unknown>).__vvWsBroadcast = () => {};
  storageRoot = mkdtempSync(join(tmpdir(), 'vv-int-actions-'));
  prevStorageRoot = process.env.STORAGE_ROOT;
  process.env.STORAGE_ROOT = storageRoot;
});

after(async () => {
  (globalThis as Record<string, unknown>).__vvWsBroadcast = prevBroadcast;
  process.env.STORAGE_ROOT = prevStorageRoot;
  await app.close();
});

function loginActionBody() {
  return {
    name: 'Login',
    description: 'Shared login keyword',
    parameters: [
      { name: 'EMAIL', default: 'tester@example.com' },
      { name: 'PASSWORD', secret: true, description: 'Account password' },
    ],
    steps: [
      {
        id: 'b1', type: 'fill', enabled: true,
        target: { primary: { strategy: 'label', value: 'Email' } },
        value: '{{EMAIL}}',
      },
      {
        id: 'b2', type: 'fill', enabled: true,
        target: { primary: { strategy: 'label', value: 'Password' } },
        value: '{{PASSWORD}}', sensitive: true,
      },
      {
        id: 'b3', type: 'click', enabled: true,
        target: { primary: { strategy: 'role', role: 'button', name: 'Login' } },
      },
    ],
  };
}

function loginTestDefinition(projectId: string, actionId: string) {
  return {
    schemaVersion: '1.0',
    id: 'test_actions_login',
    projectId,
    name: 'Login via action',
    browser: 'chromium',
    baseUrl: FIXTURE_URL,
    steps: [
      { id: 's1', type: 'goto', enabled: true, url: `${FIXTURE_URL}/fixture/login` },
      {
        id: 'c1', type: 'callAction', enabled: true, name: 'Do login',
        actionId, arguments: { PASSWORD: '{{FIXTURE_PASSWORD}}' },
      },
      {
        id: 's5', type: 'assertVisible', enabled: true,
        target: { primary: { strategy: 'text', value: 'Dashboard' } },
      },
    ],
  };
}

async function makeProject(): Promise<string> {
  const res = await injectJson(app, 'POST', '/api/v1/projects', { name: 'actions-proj' });
  assert.equal(res.statusCode, 201);
  return (res.json() as { id: string }).id;
}

describe('actions CRUD + validation', () => {
  it('creates, lists, reads, patches, and deletes an action', async () => {
    const projectId = await makeProject();
    const created = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/actions`, loginActionBody());
    assert.equal(created.statusCode, 201);
    const action = created.json() as { id: string; name: string; parameters: unknown[]; steps: unknown[] };
    assert.ok(action.id.startsWith('action_'));
    assert.equal(action.name, 'Login');
    assert.equal(action.parameters.length, 2);
    assert.equal(action.steps.length, 3);

    const listed = await injectJson(app, 'GET', `/api/v1/projects/${projectId}/actions`);
    assert.equal(listed.statusCode, 200);
    assert.ok((listed.json() as unknown[]).some((a) => (a as { id: string }).id === action.id));

    const got = await injectJson(app, 'GET', `/api/v1/actions/${action.id}`);
    assert.equal(got.statusCode, 200);
    assert.equal((got.json() as { name: string }).name, 'Login');

    const patched = await injectJson(app, 'PATCH', `/api/v1/actions/${action.id}`, {
      description: 'v2',
    });
    assert.equal(patched.statusCode, 200);
    assert.equal((patched.json() as { description: string }).description, 'v2');

    const missing = await injectJson(app, 'GET', '/api/v1/actions/action_nope');
    assert.equal(missing.statusCode, 404);

    const deleted = await injectJson(app, 'DELETE', `/api/v1/actions/${action.id}`);
    assert.equal(deleted.statusCode, 204);
    const gone = await injectJson(app, 'GET', `/api/v1/actions/${action.id}`);
    assert.equal(gone.statusCode, 404);
  });

  it('rejects duplicate names with 409 ACTION_NAME_CONFLICT', async () => {
    const projectId = await makeProject();
    const first = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/actions`, loginActionBody());
    assert.equal(first.statusCode, 201);
    const dup = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/actions`, loginActionBody());
    assert.equal(dup.statusCode, 409);
    assert.equal((dup.json() as { code: string }).code, 'ACTION_NAME_CONFLICT');
    const action = first.json() as { id: string };
    await injectJson(app, 'POST', `/api/v1/projects/${projectId}/actions`, { ...loginActionBody(), name: 'Other' });
    const rename = await injectJson(app, 'PATCH', `/api/v1/actions/${action.id}`, { name: 'Other' });
    assert.equal(rename.statusCode, 409);
  });

  it('rejects nested callAction bodies with 400 (P0-only bodies)', async () => {
    const projectId = await makeProject();
    const res = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/actions`, {
      name: 'Outer',
      parameters: [],
      steps: [{ id: 'n1', type: 'callAction', enabled: true, actionId: 'action_x' }],
    });
    assert.equal(res.statusCode, 400);
    assert.match((res.json() as { message: string }).message, /nested callAction/);
  });

  it('rejects duplicate parameter names with 400', async () => {
    const projectId = await makeProject();
    const res = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/actions`, {
      ...loginActionBody(),
      parameters: [{ name: 'EMAIL' }, { name: 'EMAIL' }],
    });
    assert.equal(res.statusCode, 400);
    assert.match((res.json() as { message: string }).message, /parameter names must be unique/);
  });

  it('rejects unknown body step types with 422 COMPILER_UNSUPPORTED_STEP', async () => {
    const projectId = await makeProject();
    const res = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/actions`, {
      name: 'Weird',
      parameters: [],
      steps: [{ id: 'w1', type: 'dragAndDrop', enabled: true }],
    });
    assert.equal(res.statusCode, 422);
    assert.equal((res.json() as { code: string }).code, 'COMPILER_UNSUPPORTED_STEP');
  });

  it('refuses to delete an action referenced by a test (409 ACTION_IN_USE)', async () => {
    const projectId = await makeProject();
    const created = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/actions`, loginActionBody());
    const action = created.json() as { id: string };
    const test = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
      name: 'uses action',
      definitionJson: loginTestDefinition(projectId, action.id),
    });
    assert.equal(test.statusCode, 201);
    const blocked = await injectJson(app, 'DELETE', `/api/v1/actions/${action.id}`);
    assert.equal(blocked.statusCode, 409);
    assert.equal((blocked.json() as { code: string }).code, 'ACTION_IN_USE');
  });
});

describe('compile/export with callAction (server resolves project actions)', () => {
  it('stores a callAction test and compiles it with the callee inlined', async () => {
    const projectId = await makeProject();
    const created = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/actions`, loginActionBody());
    assert.equal(created.statusCode, 201);
    const action = created.json() as { id: string };
    // callAction is a storable step type (server allowlist).
    const test = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
      name: 'login via action',
      definitionJson: loginTestDefinition(projectId, action.id),
    });
    assert.equal(test.statusCode, 201);
    const testId = (test.json() as { id: string }).id;

    const compiled = await injectJson(app, 'POST', `/api/v1/tests/${testId}/compile`, {});
    assert.equal(compiled.statusCode, 200);
    const code = (compiled.json() as { code: string }).code;
    // Caller default applies; secret resolves to a runtime env lookup.
    assert.match(code, /await test\.step\('Do login'/);
    assert.match(code, /getByLabel\('Email'\)\.fill\('tester@example\.com'\)/);
    assert.match(code, /process\.env\.FIXTURE_PASSWORD!/);
    assert.ok(!code.includes(SECRET), 'secret value never inlined');
    assert.ok(!code.includes('{{'), 'no uninterpolated placeholders');

    // Export serves the same spec as a file.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tests/${testId}/export?format=spec`,
      headers: { 'x-user-id': 'u_integration' },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /typescript/);
    assert.ok(res.body.includes(`await test.step('Do login'`));
  });

  it('compile fails explicitly (422) for an unknown action reference', async () => {
    const projectId = await makeProject();
    const test = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
      name: 'dangling call',
      definitionJson: loginTestDefinition(projectId, 'action_missing'),
    });
    assert.equal(test.statusCode, 201);
    const testId = (test.json() as { id: string }).id;
    const compiled = await injectJson(app, 'POST', `/api/v1/tests/${testId}/compile`, {});
    assert.equal(compiled.statusCode, 422);
    assert.equal((compiled.json() as { code: string }).code, 'COMPILER_UNSUPPORTED_STEP');
    assert.match((compiled.json() as { message: string }).message, /unknown action/);
  });
});

describe('runner parity: validate + compileSpec + stubbed run', () => {
  const action = {
    schemaVersion: '1.0' as const,
    id: 'act_login',
    projectId: 'p_actions',
    name: 'Login',
    parameters: [{ name: 'EMAIL', default: 'tester@example.com' }, { name: 'PASSWORD', secret: true }],
    steps: [
      {
        id: 'b1', type: 'fill', enabled: true,
        target: { primary: { strategy: 'label', value: 'Email' } }, value: '{{EMAIL}}',
      },
      {
        id: 'b2', type: 'fill', enabled: true,
        target: { primary: { strategy: 'label', value: 'Password' } },
        value: '{{PASSWORD}}', sensitive: true,
      },
    ],
  };

  function runnerDef() {
    return {
      schemaVersion: '1.0',
      id: 'test_runner_actions',
      projectId: 'p_actions',
      name: 'Runner actions',
      browser: 'chromium',
      baseUrl: FIXTURE_URL,
      steps: [
        { id: 's1', type: 'goto', enabled: true, url: `${FIXTURE_URL}/fixture/login` },
        {
          id: 'c1', type: 'callAction', enabled: true, name: 'Do login',
          actionId: 'act_login', arguments: { PASSWORD: '{{FIXTURE_PASSWORD}}' },
        },
      ],
    } as unknown as RunRequest['test'];
  }

  it('validateTestDefinition accepts callAction (structural checks only)', () => {
    validateTestDefinition(runnerDef() as never);
    assert.throws(
      () =>
        validateTestDefinition({
          ...runnerDef(),
          steps: [{ id: 'c9', type: 'callAction', enabled: true }],
        } as never),
      ValidationError,
    );
  });

  it('compileSpec inlines like the canonical package (outer [id], env lookup, no secret)', () => {
    const spec = compileSpec(runnerDef(), { actions: new Map([['act_login', action]]) });
    assert.match(spec, /await test\.step\("\[c1\] Do login"/);
    assert.match(spec, /getByLabel\("Email"\)\.fill\("tester@example\.com"\)/);
    assert.match(spec, /process\.env\["FIXTURE_PASSWORD"\]/);
    assert.ok(!spec.includes(SECRET));
    // Inner titles carry no [id] prefix (whole call attributes to [c1]).
    assert.ok(!spec.includes('[b1]'));
  });

  it('runner compile fails explicitly: unknown action / missing arg / plaintext secret', () => {
    assert.throws(() => compileSpec(runnerDef(), { actions: new Map() }), CompileError);
    assert.throws(
      () =>
        compileSpec(runnerDef(), {
          actions: new Map([['act_login', {
            ...action,
            parameters: [...action.parameters, { name: 'NEED' }],
          }]]),
        }),
      (e: unknown) => e instanceof CompileError && /missing required argument 'NEED'/.test((e as Error).message),
    );
    const evil = {
      ...runnerDef(),
      steps: runnerDef().steps.map((s) =>
        s.id === 'c1' ? { ...s, arguments: { PASSWORD: 'plaintext-pw' } } : s,
      ),
    };
    assert.throws(() => compileSpec(evil, { actions: new Map([['act_login', action]]) }), CompileError);
  });

  it('runTest with actions passes end-to-end (stub CLI); step events for the call step', async () => {
    const store = new InMemoryRunStore();
    const events: RunEvent[] = [];
    const runId = 'run-actions-pass-1';
    const req: RunRequest = {
      runId,
      test: runnerDef(),
      projectId: 'p_actions',
      environmentId: 'env_actions',
      browser: 'chromium',
      headed: false,
      trigger: 'integration-test',
      actions: [action],
      environmentVariables: [{ key: 'FIXTURE_PASSWORD', value: SECRET, isSecret: true }],
    };
    const { status } = await runTest(req, {
      store,
      publish: (e: RunEvent) => { events.push(e); },
      reporterPath: join(storageRoot, 'reporter.js'),
      playwrightCommand: { command: process.execPath, baseArgs: [STUB] },
    });
    assert.equal(status, 'passed');
    const names = events.map((e) => e.event);
    assert.equal(names[names.length - 1], 'run.passed');
    // The call step is one seeded record; the stub reports it like any step.
    assert.ok(names.includes('step.passed'));
    const summary = (await store.getSummary(runId))!;
    assert.equal(summary.run.status, 'passed');
    assert.ok(summary.steps.some((s) => s.stepId === 'c1' && s.status === 'passed'));
    assert.ok(existsSync(join(storageRoot, 'runs', runId, 'result.json')));
    for (const step of summary.steps) {
      if (step.errorMessage) assert.ok(!step.errorMessage.includes(SECRET));
    }
  });
});
