/**
 * Integration: stability gate + recording rubric (start-new confidence).
 *
 * POST /tests/:id/stability runs the standard run path N times sequentially
 * (REAL Chromium — needs the Playwright browser binary like
 * recorder-browser.test.ts) and stamps Test.stable only on N/N passes.
 * GET /tests/:id/rubric scores the stored definition deterministically.
 *
 * Run: npx tsx --test tests/integration/stability.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { ensureIntegrationDb, injectJson } from './helpers.js';

process.env.SKIP_LISTEN = '1';
process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
const { buildApp } = await import('../../apps/server/src/app.js');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(resolve(ROOT, 'apps', 'fixture', 'login.html'), 'utf8');

let app: FastifyInstance;
let lab: Server;
let labBase = '';

before(async () => {
  process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'vv-stability-storage-'));
  await ensureIntegrationDb();
  app = await buildApp();
  await new Promise<void>((ready) => {
    lab = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(HTML);
    }).listen(0, '127.0.0.1', () => ready());
  });
  const addr = lab.address();
  if (!addr || typeof addr === 'string') throw new Error('lab listen failed');
  labBase = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  lab.close();
  await app.close();
});

async function makeProject(name: string): Promise<string> {
  const res = await injectJson(app, 'POST', '/api/v1/projects', { name });
  assert.equal(res.statusCode, 201);
  return (res.json() as { id: string }).id;
}

async function makeGateTest(): Promise<{ testId: string; envId: string }> {
  const projectId = await makeProject(`stability-${Date.now()}`);
  const env = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/environments`, {
    name: 'lab', baseUrl: labBase,
  });
  assert.equal(env.statusCode, 201);
  const envId = (env.json() as { id: string }).id;
  const test = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
    name: 'gate demo',
    definitionJson: {
      schemaVersion: '1.0', name: 'gate demo', browser: 'chromium',
      steps: [
        { id: 's1', type: 'goto', enabled: true, name: 'Open login', url: `${labBase}/login` },
        {
          id: 's2', type: 'assertVisible', enabled: true, name: 'See Login',
          target: {
            primary: { strategy: 'role', role: 'heading', name: 'Login' },
            alternatives: [{ strategy: 'css', value: 'main h1' }],
          },
        },
      ],
    },
  });
  assert.equal(test.statusCode, 201);
  return { testId: (test.json() as { id: string }).id, envId };
}

describe('stability gate (N consecutive passes stamp the definition)', () => {
  it('stamps stable on 2/2, exposes the stamp, clears it on edit', async () => {
    const { testId, envId } = await makeGateTest();
    const gate = await injectJson(app, 'POST', `/api/v1/tests/${testId}/stability`, {
      environmentId: envId, runs: 2,
    });
    assert.equal(gate.statusCode, 200);
    const verdict = gate.json() as { runs: Array<{ id: string; status: string }>; passed: number; total: number; stable: boolean };
    assert.equal(verdict.total, 2);
    assert.deepEqual(verdict.runs.map((r) => r.status), ['passed', 'passed']);
    assert.equal(verdict.passed, 2);
    assert.equal(verdict.stable, true);

    const stamp = await injectJson(app, 'GET', `/api/v1/tests/${testId}/stability`);
    assert.equal(stamp.statusCode, 200);
    assert.deepEqual(stamp.json(), {
      testId,
      stable: true,
      stableAt: (stamp.json() as { stableAt: string }).stableAt,
      stableRuns: 2,
    });

    // Any definition edit voids the stamp.
    const patched = await injectJson(app, 'PATCH', `/api/v1/tests/${testId}`, {
      definitionJson: {
        schemaVersion: '1.0', name: 'gate demo v2', browser: 'chromium',
      steps: [
        { id: 's1', type: 'goto', enabled: true, name: 'Open login', url: `${labBase}/login` },
        {
          id: 's2', type: 'assertVisible', enabled: true, name: 'See Login',
          target: {
            primary: { strategy: 'role', role: 'heading', name: 'Login' },
            alternatives: [{ strategy: 'css', value: 'main h1' }],
          },
        },
      ],
      },
      changeMessage: 'rename',
    });
    assert.equal(patched.statusCode, 200);
    const after = (await injectJson(app, 'GET', `/api/v1/tests/${testId}/stability`)).json() as { stable: boolean; stableRuns: number };
    assert.equal(after.stable, false);
    assert.equal(after.stableRuns, 0);
  });

  it('rejects bad gate input loudly (runs range, unknown keys)', async () => {
    const { testId, envId } = await makeGateTest();
    const tooMany = await injectJson(app, 'POST', `/api/v1/tests/${testId}/stability`, { environmentId: envId, runs: 9 });
    assert.equal(tooMany.statusCode, 400);
    const junk = await injectJson(app, 'POST', `/api/v1/tests/${testId}/stability`, { environmentId: envId, nope: 1 });
    assert.equal(junk.statusCode, 400);
    const missing = await injectJson(app, 'POST', '/api/v1/tests/test_nope/stability', { environmentId: envId });
    assert.equal(missing.statusCode, 404);
  });

  async function pollGate(testId: string, gateId: string, timeoutMs = 180_000): Promise<{
    status: string; stable: boolean; passed: number; total: number;
    runs: Array<{ id: string; status: string }>; error: string | null;
  }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const cur = await injectJson(app, 'GET', `/api/v1/tests/${testId}/stability/gates/${gateId}`);
      assert.equal(cur.statusCode, 200);
      const g = cur.json() as { status: string };
      if (['passed', 'failed', 'cancelled'].includes(g.status)) {
        return g as { status: string; stable: boolean; passed: number; total: number; runs: Array<{ id: string; status: string }>; error: string | null };
      }
      assert.ok(Date.now() < deadline, `gate ${gateId} should settle (last: ${g.status})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  it('async gate: 202 immediately, poll settles passed, stamp set', async () => {
    const { testId, envId } = await makeGateTest();
    const started = await injectJson(app, 'POST', `/api/v1/tests/${testId}/stability`, {
      environmentId: envId, runs: 2, async: true,
    });
    assert.equal(started.statusCode, 202);
    const { gateId, poll } = started.json() as { gateId: string; poll: string; status: string };
    assert.ok(gateId.startsWith('gate_'));
    assert.ok(poll.endsWith(`/stability/gates/${gateId}`));

    const final = await pollGate(testId, gateId);
    assert.equal(final.status, 'passed');
    assert.equal(final.stable, true);
    assert.equal(final.passed, 2);
    assert.deepEqual(final.runs.map((r) => r.status), ['passed', 'passed']);

    const stamp = (await injectJson(app, 'GET', `/api/v1/tests/${testId}/stability`)).json() as { stable: boolean; stableRuns: number };
    assert.equal(stamp.stable, true);
    assert.equal(stamp.stableRuns, 2);
  });

  it('async gate on a failing test settles failed, no stamp, verdict lists runs', async () => {
    const projectId = await makeProject(`stability-fail-${Date.now()}`);
    const env = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/environments`, { name: 'lab', baseUrl: labBase });
    const envId = (env.json() as { id: string }).id;
    const test = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
      name: 'always red',
      definitionJson: {
        schemaVersion: '1.0', name: 'always red', browser: 'chromium',
        steps: [
          { id: 's1', type: 'goto', enabled: true, url: `${labBase}/login` },
          {
            id: 's2', type: 'assertVisible', enabled: true,
            target: { primary: { strategy: 'role', role: 'heading', name: 'Does Not Exist' }, alternatives: [] },
          },
        ],
      },
    });
    const testId = (test.json() as { id: string }).id;
    const started = await injectJson(app, 'POST', `/api/v1/tests/${testId}/stability`, {
      environmentId: envId, runs: 2, async: true,
    });
    assert.equal(started.statusCode, 202);
    const final = await pollGate(testId, (started.json() as { gateId: string }).gateId);
    assert.equal(final.status, 'failed');
    assert.equal(final.stable, false);
    assert.equal(final.error, null);
    const stamp = (await injectJson(app, 'GET', `/api/v1/tests/${testId}/stability`)).json() as { stable: boolean };
    assert.equal(stamp.stable, false);
  });

  it('async gate validates before 202; ghost gates 404', async () => {
    const { testId, envId } = await makeGateTest();
    const tooMany = await injectJson(app, 'POST', `/api/v1/tests/${testId}/stability`, {
      environmentId: envId, runs: 9, async: true,
    });
    assert.equal(tooMany.statusCode, 400);
    assert.equal((await injectJson(app, 'GET', `/api/v1/tests/${testId}/stability/gates/gate_nope`)).statusCode, 404);
    const { testId: other } = await makeGateTest();
    const started = await injectJson(app, 'POST', `/api/v1/tests/${testId}/stability`, {
      environmentId: envId, runs: 2, async: true,
    });
    const gateId = (started.json() as { gateId: string }).gateId;
    // Gate belongs to another test → 404 (no cross-test reads).
    assert.equal((await injectJson(app, 'GET', `/api/v1/tests/${other}/stability/gates/${gateId}`)).statusCode, 404);
    const final = await pollGate(testId, gateId);
    assert.equal(final.status, 'passed');
  });

  it('mid-gate definition edit discards the verdict (no stale stamp)', async () => {
    const projectId = await makeProject(`stability-stale-${Date.now()}`);
    const env = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/environments`, { name: 'lab', baseUrl: labBase });
    const envId = (env.json() as { id: string }).id;
    const mkdef = (name: string) => ({
      schemaVersion: '1.0', name, browser: 'chromium',
      // 20s x2: wide window to land a PATCH mid-gate (well under timeouts).
      steps: [{ id: 's1', type: 'waitForTimeout', enabled: true, milliseconds: 20_000 }],
    });
    const test = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
      name: 'stale race', definitionJson: mkdef('stale race'),
    });
    const testId = (test.json() as { id: string }).id;
    const started = await injectJson(app, 'POST', `/api/v1/tests/${testId}/stability`, {
      environmentId: envId, runs: 2, async: true,
    });
    assert.equal(started.statusCode, 202);
    const gateId = (started.json() as { gateId: string }).gateId;

    // Edit mid-gate: the old runs must never certify the new definition.
    await new Promise((r) => setTimeout(r, 5000));
    const patched = await injectJson(app, 'PATCH', `/api/v1/tests/${testId}`, {
      definitionJson: mkdef('stale race v2'), changeMessage: 'mid-gate edit',
    });
    assert.equal(patched.statusCode, 200);

    const final = await pollGate(testId, gateId, 180_000);
    assert.equal(final.status, 'failed');
    assert.equal(final.stable, false);
    assert.match(final.error ?? '', /definition changed during the gate/);
    assert.deepEqual(final.runs.map((r) => r.status), ['passed', 'passed']);
    const stamp = (await injectJson(app, 'GET', `/api/v1/tests/${testId}/stability`)).json() as { stable: boolean; stableRuns: number };
    assert.equal(stamp.stable, false);
    assert.equal(stamp.stableRuns, 0);
  });

  it('cancelling an async gate settles cancelled and stops the child run', async () => {
    const projectId = await makeProject(`stability-slow-${Date.now()}`);
    const env = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/environments`, { name: 'lab', baseUrl: labBase });
    const envId = (env.json() as { id: string }).id;
    const test = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
      name: 'slow gate',
      definitionJson: {
        schemaVersion: '1.0', name: 'slow gate', browser: 'chromium',
        // 20s: long enough to cancel mid-flight, well under the 30s step /
        // 60s test timeouts (a 60s sleep races the test timeout and fails).
        steps: [{ id: 's1', type: 'waitForTimeout', enabled: true, milliseconds: 20_000 }],
      },
    });
    const testId = (test.json() as { id: string }).id;
    const started = await injectJson(app, 'POST', `/api/v1/tests/${testId}/stability`, {
      environmentId: envId, runs: 2, async: true,
    });
    assert.equal(started.statusCode, 202);
    const gateId = (started.json() as { gateId: string }).gateId;

    // Wait until the first child run is actually executing, then cancel.
    const childId = await (async () => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const cur = (await injectJson(app, 'GET', `/api/v1/tests/${testId}/stability/gates/${gateId}`)).json() as {
          runs: Array<{ id: string; status: string }>;
        };
        if (cur.runs.length > 0) return cur.runs[0]!.id;
        assert.ok(Date.now() < deadline, 'gate should trigger its first run');
        await new Promise((r) => setTimeout(r, 500));
      }
    })();
    const cancelled = await injectJson(app, 'DELETE', `/api/v1/tests/${testId}/stability/gates/${gateId}`);
    assert.equal(cancelled.statusCode, 200);

    const final = await pollGate(testId, gateId, 120_000);
    if (final.status !== 'cancelled') {
      console.error('[gate-cancel-diag]', JSON.stringify(final).slice(0, 1000));
    }
    assert.equal(final.status, 'cancelled');
    // The child run must not run to completion after the cancel.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const row = (await injectJson(app, 'GET', `/api/v1/runs/${childId}`)).json() as { status: string; error?: string };
      if (['passed', 'failed', 'cancelled'].includes(row.status)) {
        if (row.status !== 'cancelled') {
          console.error('[gate-cancel-diag] child:', JSON.stringify({ status: row.status, error: (row.error ?? '').slice(0, 500) }));
        }
        assert.equal(row.status, 'cancelled');
        break;
      }
      assert.ok(Date.now() < deadline, 'child run should settle after gate cancel');
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Cancelling a settled gate is idempotent.
    assert.equal((await injectJson(app, 'DELETE', `/api/v1/tests/${testId}/stability/gates/${gateId}`)).statusCode, 200);
  });
});

describe('recording rubric (deterministic 0-100)', () => {
  it('scores the gate demo high and explains every check', async () => {
    const { testId } = await makeGateTest();
    const res = await injectJson(app, 'GET', `/api/v1/tests/${testId}/rubric`);
    assert.equal(res.statusCode, 200);
    const rubric = res.json() as { score: number; maxScore: number; checks: Array<{ id: string; earned: number; max: number }> };
    assert.equal(rubric.maxScore, 100);
    assert.equal(rubric.checks.length, 6);
    assert.equal(rubric.score, 100);
  });

  it('404s unknown tests', async () => {
    assert.equal((await injectJson(app, 'GET', '/api/v1/tests/test_nope/rubric')).statusCode, 404);
  });
});
