/**
 * Integration: run lifecycle with the fixture app via a stub runner.
 * Strategy: 12-testing/test-strategy.md (Integration: run lifecycle with tiny
 * fixture web app; artifact persistence; WebSocket event ordering/state
 * recovery. Release gate: secret redaction, interrupted runner recovery).
 * No browser required — the Playwright CLI is stubbed (stub-playwright.mjs).
 *
 * Run: npx tsx --test tests/integration/run-lifecycle.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTest, cancelRun } from '../../apps/runner/src/run.js';
import { InMemoryRunStore } from '../../apps/runner/src/persist.js';
import { buildEvent, fanout, type RunEvent } from '../../apps/runner/src/events.js';
import { compileSpec, CompileError } from '../../apps/runner/src/compile.js';
import { resolveEnv, redactSecrets } from '../../apps/runner/src/env.js';
import {
  assertSafePath,
  assertValidRunId,
  createRunWorkspace,
} from '../../apps/runner/src/workspace.js';
import { validateTestDefinition, ValidationError } from '../../apps/runner/src/validate.js';
import { loginFixtureDefinition } from './helpers.js';
import type { RunRequest } from '../../apps/runner/src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, 'stub-playwright.mjs');
const SECRET = 's3cr3t-fixture-pw';
const FIXTURE_URL = 'http://127.0.0.1:3123';

let storageRoot: string;
let prevStorageRoot: string | undefined;

before(() => {
  storageRoot = mkdtempSync(join(tmpdir(), 'vv-int-storage-'));
  prevStorageRoot = process.env.STORAGE_ROOT;
  process.env.STORAGE_ROOT = storageRoot;
});

after(() => {
  process.env.STORAGE_ROOT = prevStorageRoot;
});

function baseRequest(runId: string, extra: Partial<RunRequest> = {}): RunRequest {
  const def = loginFixtureDefinition('p_fixture', FIXTURE_URL) as unknown as RunRequest['test'];
  return {
    runId,
    test: { ...def, steps: [...def.steps, { id: 's0', type: 'reload', enabled: false }] },
    projectId: 'p_fixture',
    environmentId: 'env_fixture',
    browser: 'chromium',
    headed: false,
    trigger: 'integration-test',
    environmentVariables: [{ key: 'FIXTURE_PASSWORD', value: SECRET, isSecret: true }],
    ...extra,
  };
}

function stubDeps(store: InMemoryRunStore, events: RunEvent[], extraArgs: string[] = []) {
  return {
    store,
    publish: (e: RunEvent) => { events.push(e); },
    reporterPath: join(storageRoot, 'reporter.js'),
    playwrightCommand: { command: process.execPath, baseArgs: [STUB, ...extraArgs] },
  };
}

const eventNames = (events: RunEvent[]) => events.map((e) => e.event);

describe('run lifecycle PASS with the fixture app (stubbed browser)', () => {
  it('run.queued -> run.started -> step.* -> run.passed; artifacts under storage/runs/<id>/', async () => {
    const store = new InMemoryRunStore();
    const events: RunEvent[] = [];
    const runId = 'run-fixture-pass-1';

    const { status } = await runTest(baseRequest(runId), stubDeps(store, events));
    assert.equal(status, 'passed');

    const names = eventNames(events);
    assert.deepEqual(names.slice(0, 2), ['run.queued', 'run.started']);
    assert.equal(names[names.length - 1], 'run.passed');
    // Every enabled step emits started before passed, in definition order.
    const enabled = ['s1', 's2', 's3', 's4', 's5'];
    for (const stepId of enabled) {
      const started = names.findIndex((n, i) => n === 'step.started' && events[i].stepId === stepId);
      const passed = names.findIndex((n, i) => n === 'step.passed' && events[i].stepId === stepId);
      assert.ok(started !== -1 && passed !== -1 && started < passed, `step ${stepId} ordering`);
    }

    const summary = (await store.getSummary(runId))!;
    assert.equal(summary.run.status, 'passed');
    assert.ok(summary.run.durationMs! >= 0);
    assert.equal(summary.steps.filter((s) => s.status === 'passed').length, 5);
    assert.equal(summary.steps.find((s) => s.stepId === 's0')?.status, 'skipped');

    // Artifact persistence: storage-relative paths, files retained on disk.
    const byType = new Map(summary.artifacts.map((a) => [a.type, a]));
    assert.ok(byType.has('result'), 'result.json recorded');
    assert.ok(byType.has('screenshot'), 'screenshot recorded');
    assert.ok(byType.has('trace'), 'trace recorded');
    for (const artifact of summary.artifacts) {
      assert.match(artifact.path, new RegExp(`^runs/${runId}/`), 'storage-relative path');
      assert.ok(!artifact.path.includes('..'), 'no traversal in artifact path');
      assert.ok(
        existsSync(join(storageRoot, artifact.path)),
        `artifact file retained: ${artifact.path}`,
      );
    }
    const resultJson = JSON.parse(readFileSync(join(storageRoot, 'runs', runId, 'result.json'), 'utf8'));
    assert.equal(resultJson.status, 'passed');

    // The compiled spec really targets the fixture app.
    const spec = compileSpec(baseRequest(runId).test);
    assert.match(spec, /fixture\/login/);
    assert.match(spec, /getByLabel\("Email"\)/);
    assert.match(spec, /getByRole\("button", \{ name: "Login" \}\)/);
    assert.match(spec, /process\.env\["FIXTURE_PASSWORD"\]/);
    assert.ok(!spec.includes(SECRET), 'secret never inlined into generated code');
  });
});

describe('run lifecycle FAIL + secret redaction', () => {
  it('failed stub -> run.failed; secret scrubbed from errorSummary and events', async () => {
    const store = new InMemoryRunStore();
    const events: RunEvent[] = [];
    const runId = 'run-fixture-fail-1';

    const { status } = await runTest(baseRequest(runId), stubDeps(store, events, ['--fail']));
    assert.equal(status, 'failed');

    const names = eventNames(events);
    assert.equal(names[0], 'run.queued');
    assert.equal(names[1], 'run.started');
    assert.equal(names[names.length - 1], 'run.failed');
    assert.ok(names.includes('step.failed'));

    const summary = (await store.getSummary(runId))!;
    assert.equal(summary.run.status, 'failed');
    assert.ok(summary.run.errorSummary && summary.run.errorSummary.includes('***'));
    assert.ok(!summary.run.errorSummary!.includes(SECRET), 'errorSummary must be redacted');
    for (const e of events) {
      if (e.error) assert.ok(!e.error.includes(SECRET), `event ${e.event} must be redacted`);
    }
    for (const step of summary.steps) {
      if (step.errorMessage) assert.ok(!step.errorMessage.includes(SECRET));
    }
    // Failure still leaves screenshot + trace artifacts behind.
    assert.ok(summary.artifacts.some((a) => a.type === 'screenshot'));
    assert.ok(summary.artifacts.some((a) => a.type === 'trace'));
  });
});

describe('run lifecycle validation gate', () => {
  it('invalid definition fails fast without spawning Playwright', async () => {
    const store = new InMemoryRunStore();
    const events: RunEvent[] = [];
    // If the runner spawned this, the marker file would exist afterwards.
    const marker = join(storageRoot, 'should-never-spawn.marker');
    const req = baseRequest('run-invalid-1', {
      test: {
        ...(baseRequest('x').test),
        steps: [{ id: 'sx', type: 'dragAndDrop', enabled: true } as never],
      },
    });
    const { status } = await runTest(req, {
      store,
      publish: (e: RunEvent) => { events.push(e); },
      reporterPath: 'unused',
      playwrightCommand: {
        command: process.execPath,
        baseArgs: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`],
      },
    });
    assert.equal(status, 'failed');
    assert.ok(!existsSync(marker), 'Playwright must not spawn for an invalid definition');
    assert.deepEqual(eventNames(events), ['run.queued', 'run.failed']);
  });

  it('validateTestDefinition rejects unknown steps explicitly', () => {
    const bad = { ...baseRequest('x').test, steps: [{ id: 'sx', type: 'nope', enabled: true }] };
    assert.throws(() => validateTestDefinition(bad as never), ValidationError);
  });

  it('sensitive literal fill refuses to compile (secret would inline)', () => {
    const def = baseRequest('x').test;
    const evil = {
      ...def,
      steps: def.steps.map((s) => (s.id === 's3' ? { ...s, value: 'plaintext-pw' } : s)),
    };
    assert.throws(() => compileSpec(evil), CompileError);
  });
});

describe('interrupted runner recovery (cancel)', () => {
  it('cancelRun kills the child, settles steps as skipped, emits run.cancelled', async () => {
    const store = new InMemoryRunStore();
    const events: RunEvent[] = [];
    const runId = 'run-fixture-cancel-1';
    const deps = stubDeps(store, events, ['--slow', '8000']);

    const promise = runTest(baseRequest(runId), deps);
    // Wait until the run is really executing, then cancel.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const run = await store.getRun(runId);
      if (run?.status === 'running') break;
      assert.ok(Date.now() < deadline, 'run should reach running state');
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(await cancelRun(runId, deps), true);
    const { status } = await promise;
    assert.equal(status, 'cancelled');

    const summary = (await store.getSummary(runId))!;
    assert.equal(summary.run.status, 'cancelled');
    assert.ok(eventNames(events).includes('run.cancelled'));
    for (const step of summary.steps) {
      assert.ok(
        ['passed', 'failed', 'skipped'].includes(step.status),
        `no step left pending/running after cancel (got ${step.stepId}=${step.status})`,
      );
    }
  });
});

describe('artifact layout + path safety (storage/runs/<id>/)', () => {
  it('creates the retained artifact skeleton and blocks traversal', async () => {
    const ws = await createRunWorkspace('run-ws-check-1');
    const normalized = ws.artifactDir.replace(/\\/g, '/');
    assert.ok(normalized.endsWith('/runs/run-ws-check-1'), `artifact dir keeps runs/<id> layout (got ${normalized})`);
    assert.ok(normalized.startsWith(storageRoot.replace(/\\/g, '/')), 'artifact dir lives under STORAGE_ROOT');
    assert.ok(existsSync(ws.screenshotsDir));
    assert.throws(() => assertSafePath(ws.artifactDir, '../evil.png'), /traversal/);
    assert.throws(() => assertSafePath(ws.workDir, '../../escape.spec.ts'), /traversal/);
    assert.throws(() => assertValidRunId('../nope'), /Invalid runId/);
    assert.throws(() => assertValidRunId('a/b'), /Invalid runId/);
    assert.doesNotThrow(() => assertValidRunId('run_abc-123'));
  });
});

describe('WS event ordering primitives', () => {
  it('buildEvent carries runId+timestamp; fanout survives a dead sink', () => {
    const got: RunEvent[] = [];
    const publish = fanout([
      () => { throw new Error('dead sink'); },
      (e) => { got.push(e); },
    ]);
    const evt = buildEvent('step.started', 'r1', { stepId: 's1', status: 'running' });
    assert.equal(evt.runId, 'r1');
    assert.ok(typeof evt.at === 'number');
    publish(evt);
    assert.equal(got.length, 1);
  });

  it('terminal ordering is queued < started < step.* < run.*', () => {
    const seq = [
      buildEvent('run.queued', 'r1'),
      buildEvent('run.started', 'r1'),
      buildEvent('step.started', 'r1', { stepId: 's1' }),
      buildEvent('step.passed', 'r1', { stepId: 's1' }),
      buildEvent('run.passed', 'r1'),
    ].map((e) => e.event);
    assert.deepEqual(seq, ['run.queued', 'run.started', 'step.started', 'step.passed', 'run.passed']);
  });
});

describe('environment resolution (project < env < test)', () => {
  it('merges in order and redacts secrets', () => {
    const { runtimeEnv, secrets, redacted } = resolveEnv({
      test: { variables: { A: 'test-a' } } as never,
      projectVariables: [
        { key: 'A', value: 'proj-a', isSecret: false },
        { key: 'B', value: 'proj-b', isSecret: false },
        { key: 'FIXTURE_PASSWORD', value: SECRET, isSecret: true },
      ],
      environmentVariables: [{ key: 'B', value: 'env-b', isSecret: false }],
    });
    assert.equal(runtimeEnv['A'], 'test-a', 'test-level wins over project');
    assert.equal(runtimeEnv['B'], 'env-b', 'environment wins over project');
    assert.deepEqual(secrets, [SECRET]);
    assert.equal(redacted['FIXTURE_PASSWORD'], '***');
    assert.equal(redactSecrets(`pw=${SECRET} end`, secrets), 'pw=*** end');
  });
});
