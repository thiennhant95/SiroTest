/**
 * Integration: P1 Suites/tags + Suite parallelism/retries + JUnit export.
 * Strategy: real Fastify app + isolated SQLite file (never dev.db), real
 * browser runs for the pass path (tiny waitForTimeout steps, deterministic),
 * validation-gate failure (no browser needed) for the retry path.
 *
 * Run: npx tsx --test tests/integration/suites.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import {
  ensureIntegrationDb,
  injectJson,
} from './helpers.js';

process.env.SKIP_LISTEN = '1';
const { buildApp } = await import('../../apps/server/src/app.js');
const { db } = await import('../../apps/server/src/db.js');

let app: FastifyInstance;

before(async () => {
  await ensureIntegrationDb();
  app = await buildApp();
});

after(async () => {
  await app.close();
});

function waitDef(projectId: string, ms: number, tags?: string[]) {
  return {
    schemaVersion: '1.0',
    id: `test_wait_${ms}`,
    projectId,
    name: `wait ${ms}ms`,
    browser: 'chromium',
    ...(tags ? { tags } : {}),
    steps: [{ id: 's1', type: 'waitForTimeout', enabled: true, milliseconds: ms }],
  };
}

async function makeProject(name: string): Promise<string> {
  const res = await injectJson(app, 'POST', '/api/v1/projects', { name });
  assert.equal(res.statusCode, 201);
  return (res.json() as { id: string }).id;
}

async function makeEnv(projectId: string): Promise<string> {
  const res = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/environments`, {
    name: 'suite-env', baseUrl: 'http://127.0.0.1:3123',
  });
  assert.equal(res.statusCode, 201);
  return (res.json() as { id: string }).id;
}

async function makeTest(projectId: string, name: string, definition: unknown): Promise<string> {
  const res = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
    name, definitionJson: definition,
  });
  assert.equal(res.statusCode, 201);
  return (res.json() as { id: string }).id;
}

async function makeSuite(projectId: string, name: string): Promise<string> {
  const res = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/suites`, { name });
  assert.equal(res.statusCode, 201);
  return (res.json() as { id: string }).id;
}

async function waitSuiteTerminal(suiteRunId: string, timeoutMs: number): Promise<{ status: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const cur = await injectJson(app, 'GET', `/api/v1/suite-runs/${suiteRunId}`);
    assert.equal(cur.statusCode, 200);
    const body = cur.json() as { status: string };
    if (['passed', 'failed', 'cancelled'].includes(body.status)) return body;
    assert.ok(Date.now() < deadline, `suite run ${suiteRunId} should settle (last: ${body.status})`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

describe('suites CRUD', () => {
  it('creates, reads, updates, lists and deletes a suite', async () => {
    const projectId = await makeProject('suite-crud-proj');
    const sid = await makeSuite(projectId, 'smoke suite');

    const got = await injectJson(app, 'GET', `/api/v1/suites/${sid}`);
    assert.equal(got.statusCode, 200);
    assert.equal((got.json() as { name: string }).name, 'smoke suite');

    const patched = await injectJson(app, 'PATCH', `/api/v1/suites/${sid}`, {
      description: 'p1 suite',
    });
    assert.equal(patched.statusCode, 200);
    assert.equal((patched.json() as { description: string }).description, 'p1 suite');

    const listed = await injectJson(app, 'GET', `/api/v1/projects/${projectId}/suites`);
    assert.equal(listed.statusCode, 200);
    assert.ok(((listed.json() as unknown[]).length) >= 1);

    const deleted = await injectJson(app, 'DELETE', `/api/v1/suites/${sid}`);
    assert.equal(deleted.statusCode, 204);
    const gone = await injectJson(app, 'GET', `/api/v1/suites/${sid}`);
    assert.equal(gone.statusCode, 404);
  });

  it('rejects invalid payloads and unknown suites', async () => {
    const projectId = await makeProject('suite-crud-proj-2');
    const bad = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/suites`, {});
    assert.equal(bad.statusCode, 400);
    const missing = await injectJson(app, 'GET', '/api/v1/suites/suite_nope');
    assert.equal(missing.statusCode, 404);
  });
});

describe('suite members + reorder', () => {
  it('adds, reorders (PUT), re-sorts (POST sortOrder) and removes members', async () => {
    const projectId = await makeProject('suite-members-proj');
    const t1 = await makeTest(projectId, 'm1', waitDef(projectId, 100));
    const t2 = await makeTest(projectId, 'm2', waitDef(projectId, 100));
    const t3 = await makeTest(projectId, 'm3', waitDef(projectId, 100));
    const sid = await makeSuite(projectId, 'member suite');

    for (const tid of [t1, t2, t3]) {
      const added = await injectJson(app, 'POST', `/api/v1/suites/${sid}/tests`, { testId: tid });
      assert.equal(added.statusCode, 201);
    }
    const dup = await injectJson(app, 'POST', `/api/v1/suites/${sid}/tests`, { testId: t1 });
    assert.equal(dup.statusCode, 409);

    // Full ordered replace = reorder.
    const reordered = await injectJson(app, 'PUT', `/api/v1/suites/${sid}/tests`, {
      testIds: [t3, t1, t2],
    });
    assert.equal(reordered.statusCode, 200);
    assert.deepEqual(
      (reordered.json() as Array<{ testId: string; sortOrder: number }>).map((m) => m.testId),
      [t3, t1, t2],
    );

    // Re-POST with sortOrder moves a single member.
    const moved = await injectJson(app, 'POST', `/api/v1/suites/${sid}/tests`, {
      testId: t2, sortOrder: -5,
    });
    assert.equal(moved.statusCode, 200);

    const members = (await injectJson(app, 'GET', `/api/v1/suites/${sid}/tests`)).json() as Array<{
      testId: string; sortOrder: number;
    }>;
    assert.deepEqual(
      [...members].sort((a, b) => a.sortOrder - b.sortOrder).map((m) => m.testId),
      [t2, t3, t1],
    );

    const removed = await injectJson(app, 'DELETE', `/api/v1/suites/${sid}/tests/${t2}`);
    assert.equal(removed.statusCode, 204);
    const again = await injectJson(app, 'DELETE', `/api/v1/suites/${sid}/tests/${t2}`);
    assert.equal(again.statusCode, 404);
  });

  it('rejects cross-project members and unknown tests', async () => {
    const p1 = await makeProject('suite-x-a');
    const p2 = await makeProject('suite-x-b');
    const foreign = await makeTest(p2, 'foreign', waitDef(p2, 100));
    const sid = await makeSuite(p1, 'x suite');
    const res = await injectJson(app, 'POST', `/api/v1/suites/${sid}/tests`, { testId: foreign });
    assert.equal(res.statusCode, 400);
    const nope = await injectJson(app, 'POST', `/api/v1/suites/${sid}/tests`, { testId: 'test_nope' });
    assert.equal(nope.statusCode, 404);
  });
});

describe('tags', () => {
  it('lists distinct tags with counts and filters tests by tag', async () => {
    const projectId = await makeProject('suite-tags-proj');
    await makeTest(projectId, 'tagged login', waitDef(projectId, 100, ['smoke', 'login']));
    await makeTest(projectId, 'tagged checkout', waitDef(projectId, 100, ['smoke', 'checkout']));
    await makeTest(projectId, 'untagged', waitDef(projectId, 100));

    const tagsRes = await injectJson(app, 'GET', `/api/v1/projects/${projectId}/tags`);
    assert.equal(tagsRes.statusCode, 200);
    const tags = tagsRes.json() as Array<{ tag: string; count: number }>;
    const byTag = new Map(tags.map((t) => [t.tag, t.count]));
    assert.equal(byTag.get('smoke'), 2);
    assert.equal(byTag.get('login'), 1);
    assert.equal(byTag.get('checkout'), 1);
    assert.ok(!byTag.has('nope'));

    const filtered = await injectJson(app, 'GET', `/api/v1/projects/${projectId}/tests?tag=smoke`);
    assert.equal(filtered.statusCode, 200);
    assert.equal((filtered.json() as unknown[]).length, 2);
    const all = await injectJson(app, 'GET', `/api/v1/projects/${projectId}/tests`);
    assert.equal((all.json() as unknown[]).length, 3);
  });
});

describe('suite runs (parallel) + JUnit export', () => {
  it('runs 2 tests in one suiteRunId, both pass; JUnit XML is well-formed', async () => {
    const projectId = await makeProject('suite-run-proj');
    const envId = await makeEnv(projectId);
    const t1 = await makeTest(projectId, 's-pass-1', waitDef(projectId, 200));
    const t2 = await makeTest(projectId, 's-pass-2', waitDef(projectId, 200));
    const sid = await makeSuite(projectId, 'pass suite');
    await injectJson(app, 'POST', `/api/v1/suites/${sid}/tests`, { testId: t1 });
    await injectJson(app, 'POST', `/api/v1/suites/${sid}/tests`, { testId: t2 });

    const started = await injectJson(app, 'POST', `/api/v1/suites/${sid}/runs`, {
      environmentId: envId,
    });
    assert.equal(started.statusCode, 202);
    const { suiteRunId, runs } = started.json() as {
      suiteRunId: string; runs: Array<{ id: string; testId: string }>;
    };
    assert.ok(suiteRunId);
    assert.equal(runs.length, 2);

    const final = await waitSuiteTerminal(suiteRunId, 120_000) as {
      status: string; tests: Array<{ testId: string; finalStatus: string; retryCount: number }>;
    };
    assert.equal(final.status, 'passed');
    assert.equal(final.tests.length, 2);
    for (const t of final.tests) {
      assert.equal(t.finalStatus, 'passed');
      assert.equal(t.retryCount, 0);
    }

    // Every child run carries the suite linkage + trigger 'suite'.
    for (const r of runs) {
      const row = await db().run.findUnique({ where: { id: r.id } });
      assert.equal(row?.suiteRunId, suiteRunId);
      assert.equal(row?.suiteId, sid);
      assert.equal(row?.trigger, 'suite');
    }

    // Suite executions list groups by suiteRunId with counts.
    const listed = (await injectJson(app, 'GET', `/api/v1/suites/${sid}/runs`)).json() as Array<{
      suiteRunId: string; status: string; counts: { total: number; passed: number; failed: number };
    }>;
    const exec = listed.find((e) => e.suiteRunId === suiteRunId)!;
    assert.ok(exec);
    assert.equal(exec.status, 'passed');
    assert.deepEqual([exec.counts.total, exec.counts.passed], [2, 2]);

    // JUnit export for the suite run.
    const xmlRes = await injectJson(app, 'GET', `/api/v1/suite-runs/${suiteRunId}/export?format=junit`);
    assert.equal(xmlRes.statusCode, 200);
    assert.match(xmlRes.headers['content-type'] as string, /application\/xml/);
    assert.match(xmlRes.headers['content-disposition'] as string, /\.junit\.xml/);
    assert.match(xmlRes.body, /<testsuites tests="2" failures="0"/);
    assert.match(xmlRes.body, /<testsuite /);
    assert.equal((xmlRes.body.match(/<testcase /g) ?? []).length, 2);

    // JUnit export for a single run.
    const single = await injectJson(app, 'GET', `/api/v1/runs/${runs[0]!.id}/export?format=junit`);
    assert.equal(single.statusCode, 200);
    assert.match(single.body, /<testsuites tests="1" failures="0"/);

    const badFormat = await injectJson(app, 'GET', `/api/v1/runs/${runs[0]!.id}/export?format=pdf`);
    assert.equal(badFormat.statusCode, 400);
  });

  it('rejects empty suites, bad envs and out-of-range parallel/retries', async () => {
    const projectId = await makeProject('suite-run-bad-proj');
    const envId = await makeEnv(projectId);
    const emptySid = await makeSuite(projectId, 'empty suite');
    const empty = await injectJson(app, 'POST', `/api/v1/suites/${emptySid}/runs`, {
      environmentId: envId,
    });
    assert.equal(empty.statusCode, 400);

    const t1 = await makeTest(projectId, 'x1', waitDef(projectId, 100));
    const sid = await makeSuite(projectId, 'bad params suite');
    await injectJson(app, 'POST', `/api/v1/suites/${sid}/tests`, { testId: t1 });

    const foreignEnv = await injectJson(app, 'POST', `/api/v1/suites/${sid}/runs`, {
      environmentId: 'env_nope',
    });
    assert.equal(foreignEnv.statusCode, 400);

    const badParallel = await injectJson(app, 'POST', `/api/v1/suites/${sid}/runs`, {
      environmentId: envId, parallel: 5,
    });
    assert.equal(badParallel.statusCode, 400);

    const badRetries = await injectJson(app, 'POST', `/api/v1/suites/${sid}/runs`, {
      environmentId: envId, retries: 9,
    });
    assert.equal(badRetries.statusCode, 400);
  });
});

describe('suite retries (deterministic failure via validation gate)', () => {
  it('failed test re-enqueues up to N times as suite-retry attempts', async () => {
    const projectId = await makeProject('suite-retry-proj');
    const envId = await makeEnv(projectId);
    // API persist validation blocks unknown steps, so inject the failing
    // definition directly: the runner validation gate fails it fast without
    // spawning a browser (deterministic, no flakiness).
    const badDef = {
      schemaVersion: '1.0',
      id: 'test_always_fail',
      projectId,
      name: 'always fail',
      browser: 'chromium',
      steps: [{ id: 'sx', type: 'nope-not-a-step', enabled: true }],
    };
    const t1 = await makeTest(projectId, 'flaky', waitDef(projectId, 100));
    await db().test.update({ where: { id: t1 }, data: { definitionJson: JSON.stringify(badDef) } });
    const sid = await makeSuite(projectId, 'retry suite');
    await injectJson(app, 'POST', `/api/v1/suites/${sid}/tests`, { testId: t1 });

    const started = await injectJson(app, 'POST', `/api/v1/suites/${sid}/runs`, {
      environmentId: envId, retries: 2, parallel: 1,
    });
    assert.equal(started.statusCode, 202);
    const { suiteRunId } = started.json() as { suiteRunId: string };

    const final = await waitSuiteTerminal(suiteRunId, 90_000) as {
      status: string; tests: Array<{ retryCount: number; finalStatus: string }>;
    };
    assert.equal(final.status, 'failed');
    assert.equal(final.tests.length, 1);
    assert.equal(final.tests[0]!.finalStatus, 'failed');
    assert.equal(final.tests[0]!.retryCount, 2, 'initial + 2 retries = 3 attempts');

    const attempts = await db().run.findMany({ where: { suiteRunId } });
    assert.equal(attempts.length, 3);
    assert.deepEqual(
      attempts.map((a) => a.trigger).sort(),
      ['suite', 'suite-retry', 'suite-retry'],
    );
  });
});

describe('JUnit secret redaction boundary', () => {
  it('scrubs secret plaintext from exported XML even if stored text leaks it', async () => {
    const projectId = await makeProject('suite-junit-secret-proj');
    const envId = await makeEnv(projectId);
    const secret = 's3cr3t-junit-leak-zzz';
    const created = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/variables`, {
      key: 'LEAK_PW', value: secret, isSecret: true,
    });
    assert.equal(created.statusCode, 201);

    const t1 = await makeTest(projectId, 'leaky', waitDef(projectId, 100));
    const sid = await makeSuite(projectId, 'secret suite');
    await injectJson(app, 'POST', `/api/v1/suites/${sid}/tests`, { testId: t1 });
    const started = await injectJson(app, 'POST', `/api/v1/suites/${sid}/runs`, { environmentId: envId });
    const { suiteRunId, runs } = started.json() as { suiteRunId: string; runs: Array<{ id: string }> };
    await waitSuiteTerminal(suiteRunId, 120_000);

    // Simulate a stored summary that still carries the secret (worst case):
    // the export boundary must scrub it anyway.
    await db().run.update({
      where: { id: runs[0]!.id },
      data: { errorSummary: `boom leaked ${secret} end`, status: 'failed' },
    });
    const xmlRes = await injectJson(app, 'GET', `/api/v1/suite-runs/${suiteRunId}/export?format=junit`);
    assert.equal(xmlRes.statusCode, 200);
    assert.ok(!xmlRes.body.includes(secret), 'secret plaintext must not appear in JUnit XML');
    assert.ok(xmlRes.body.includes('***'), 'redaction marker present');
  });
});

describe('suite cancel', () => {
  it('cancels queued/running children and stops the execution', async () => {
    const projectId = await makeProject('suite-cancel-proj');
    const envId = await makeEnv(projectId);
    const slowDef = {
      schemaVersion: '1.0',
      id: 'test_slow_suite',
      projectId,
      name: 'slow suite test',
      browser: 'chromium',
      steps: [{ id: 's1', type: 'waitForTimeout', enabled: true, milliseconds: 30000 }],
    };
    const t1 = await makeTest(projectId, 'slow-1', slowDef);
    const t2 = await makeTest(projectId, 'slow-2', slowDef);
    const sid = await makeSuite(projectId, 'cancel suite');
    await injectJson(app, 'POST', `/api/v1/suites/${sid}/tests`, { testId: t1 });
    await injectJson(app, 'POST', `/api/v1/suites/${sid}/tests`, { testId: t2 });

    const started = await injectJson(app, 'POST', `/api/v1/suites/${sid}/runs`, { environmentId: envId });
    const { suiteRunId } = started.json() as { suiteRunId: string };

    // Wait until at least one child is really running (real tree-kill path).
    const deadline = Date.now() + 60_000;
    for (;;) {
      const cur = (await injectJson(app, 'GET', `/api/v1/suite-runs/${suiteRunId}`)).json() as {
        status: string;
      };
      if (cur.status === 'running') break;
      assert.ok(Date.now() < deadline, 'a child run should reach running');
      await new Promise((r) => setTimeout(r, 500));
    }

    const cancelled = await injectJson(app, 'POST', `/api/v1/suite-runs/${suiteRunId}/cancel`);
    assert.equal(cancelled.statusCode, 200);
    const body = cancelled.json() as { cancelled: string[]; alreadyTerminal: string[] };
    assert.ok(body.cancelled.length >= 1);

    const final = await waitSuiteTerminal(suiteRunId, 60_000);
    assert.equal(final.status, 'cancelled');

    const repeat = await injectJson(app, 'POST', `/api/v1/suite-runs/${suiteRunId}/cancel`);
    assert.equal(repeat.statusCode, 200);
    assert.deepEqual((repeat.json() as { cancelled: string[] }).cancelled, []);

    const missing = await injectJson(app, 'POST', '/api/v1/suite-runs/sr_nope/cancel');
    assert.equal(missing.statusCode, 404);
  });
});
