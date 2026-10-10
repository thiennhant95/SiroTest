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
