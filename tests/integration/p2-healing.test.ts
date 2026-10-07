/**
 * Integration: P2 explicit, reviewable locator healing + suggested assertions.
 *
 * Healing NEVER auto-applies — it only proposes; a human approves/rejects.
 *   - Runner (no browser): pure healing logic (classify/order/probe) + runTest
 *     with the stub Playwright CLI (stub-playwright.mjs --fail). Default
 *     (no flag) keeps P0 behavior: no step.healed events, empty healing[].
 *   - Server API (real Fastify app + isolated SQLite): proposal creation with
 *     pending-dedupe, approve (primary<->toLocator + version bump), reject,
 *     stale-primary guard, and deterministic suggestion generate/apply.
 *
 * Run: npx tsx --test tests/integration/p2-healing.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { runTest } from '../../apps/runner/src/run.js';
import { InMemoryRunStore } from '../../apps/runner/src/persist.js';
import {
  attemptHealing,
  isLocatorBearingStep,
  isLocatorFailure,
  STEP_HEALED_EVENT,
} from '../../apps/runner/src/healing.js';
import type { RunEvent } from '../../apps/runner/src/events.js';
import type { RunRequest } from '../../apps/runner/src/types.js';
import { ensureIntegrationDb, injectJson } from './helpers.js';

process.env.SKIP_LISTEN = '1';
const { buildApp } = await import('../../apps/server/src/app.js');
const { createHealingProposalsFromEvidence } = await import(
  '../../apps/server/src/routes/healing.js'
);
const { buildSuggestions } = await import(
  '../../apps/server/src/routes/suggestions.js'
);

// ---------------------------------------------------------------------------
// Part A — runner healing (stub CLI, no browser)
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, 'stub-playwright.mjs');
const SECRET = 's3cr3t-heal-pw';
const FIXTURE_URL = 'http://127.0.0.1:3123';

let storageRoot: string;
let prevStorageRoot: string | undefined;

before(() => {
  storageRoot = mkdtempSync(join(tmpdir(), 'vv-p2-storage-'));
  prevStorageRoot = process.env.STORAGE_ROOT;
  process.env.STORAGE_ROOT = storageRoot;
});

after(() => {
  process.env.STORAGE_ROOT = prevStorageRoot;
});

const PRIMARY = { strategy: 'role', role: 'button', name: 'Missing' } as const;
const ALT_CSS = { strategy: 'css', value: '.nope' } as const;
const ALT_TESTID = { strategy: 'testId', value: 'login-btn' } as const;

function clickStep() {
  return {
    id: 'h1',
    type: 'click',
    enabled: true,
    target: {
      primary: { ...PRIMARY },
      alternatives: [{ ...ALT_CSS }, { ...ALT_TESTID }],
    },
  };
}

function healRequest(runId: string, extra: Partial<RunRequest> = {}): RunRequest {
  return {
    runId,
    test: {
      schemaVersion: '1.0',
      id: 'test_heal',
      projectId: 'p_heal',
      name: 'Heal me',
      browser: 'chromium',
      baseUrl: FIXTURE_URL,
      steps: [clickStep(), { id: 'h2', type: 'goto', enabled: true, url: `${FIXTURE_URL}/fixture/login` }],
    } as unknown as RunRequest['test'],
    projectId: 'p_heal',
    browser: 'chromium',
    trigger: 'p2-test',
    environmentVariables: [{ key: 'FIXTURE_PASSWORD', value: SECRET, isSecret: true }],
    ...extra,
  };
}

function stubDeps(store: InMemoryRunStore, events: RunEvent[], extraArgs: string[] = []) {
  return {
    store,
    publish: (e: RunEvent) => {
      events.push(e);
    },
    reporterPath: join(storageRoot, 'reporter.js'),
    playwrightCommand: { command: process.execPath, baseArgs: [STUB, ...extraArgs] },
  };
}

describe('P2 healing classification (pure, no browser)', () => {
  it('isLocatorFailure: timeouts/waiting/strict-mode yes; assertions/other no', () => {
    assert.equal(isLocatorFailure('Timeout 5000ms exceeded, waiting for getByRole("button")'), true);
    assert.equal(isLocatorFailure('waiting for selector ".x" to be visible'), true);
    assert.equal(isLocatorFailure('strict mode violation: getByTestId("a") resolved to 2 elements'), true);
    assert.equal(isLocatorFailure(''), false);
    assert.equal(isLocatorFailure('plain boom'), false);
    // Playwright expect failures also time out — they must NEVER heal.
    assert.equal(isLocatorFailure('Timeout 5000ms exceeded.\nExpected: visible\nReceived: hidden'), false);
    assert.equal(isLocatorFailure('expect(locator).toBeVisible() failed'), false);
    assert.equal(isLocatorFailure('AssertionError: expected 200 to be 404'), false);
    // ...UNLESS the call log proves the locator resolved to nothing (the
    // element is gone, not the expectation wrong) — then it IS healable.
    assert.equal(
      isLocatorFailure(
        'Error: expect(locator).toBeVisible() failed\nLocator: locator(\'#nope\')\nTimeout: 5000ms\nError: element(s) not found',
      ),
      true,
    );
  });

  it('attemptHealing walks alternatives in order, first unique match wins', () => {
    const attempt = attemptHealing(clickStep() as never, 'waiting for selector ".x"', (c) =>
      c.strategy === 'testId' ? 1 : 0,
    );
    assert.ok(attempt);
    assert.deepEqual(attempt.evidence.tried, ['css=".nope"', 'testId="login-btn"']);
    assert.deepEqual(attempt.evidence.succeededWith, { ...ALT_TESTID });
    assert.equal(attempt.evidence.matchCount, 1);
    assert.equal(attempt.evidence.verified, true);
  });

  it('attemptHealing returns null outside its scope; unverified attempt has no winner', () => {
    assert.equal(attemptHealing({ id: 'g', type: 'goto', enabled: true } as never, 'waiting for selector'), null);
    assert.equal(attemptHealing(clickStep() as never, 'waiting for selector', undefined)?.evidence.verified, false);
    assert.equal(
      attemptHealing(clickStep() as never, 'waiting for selector', undefined)?.evidence.succeededWith,
      undefined,
    );
    assert.equal(attemptHealing(clickStep() as never, 'plain boom', () => 1), null);
    assert.equal(
      attemptHealing({ ...clickStep(), target: { primary: { ...PRIMARY } } } as never, 'waiting for selector', () => 1),
      null,
    );
    assert.equal(isLocatorBearingStep({ type: 'click' }), true);
    assert.equal(isLocatorBearingStep({ type: 'goto' }), false);
    // A throwing probe must not fail the run — it degrades to unverified.
    const t = attemptHealing(clickStep() as never, 'Timeout 1ms exceeded', () => {
      throw new Error('probe exploded');
    });
    assert.ok(t && t.evidence.verified === false);
  });
});

describe('P2 runner healing flow (stub CLI)', () => {
  it('opt-in: failed locator step stays failed but emits step.healed + evidence', async () => {
    const store = new InMemoryRunStore();
    const events: RunEvent[] = [];
    const deps = {
      ...stubDeps(store, events, ['--fail']),
      healProbe: (c: { strategy: string }) => (c.strategy === 'testId' ? 1 : 0),
    };
    const { status, healing } = await runTest(healRequest('run-heal-optin-1', { healWithAlternatives: true }), deps);
    assert.equal(status, 'failed');

    const summary = (await store.getSummary('run-heal-optin-1'))!;
    const h1 = summary.steps.find((s) => s.stepId === 'h1')!;
    assert.equal(h1.status, 'failed', 'primary failure stays failed — healing never flips it');
    assert.ok(h1.errorMessage && !h1.errorMessage.includes(SECRET), 'error stays redacted');

    const healed = events.filter((e) => (e.event as string) === STEP_HEALED_EVENT);
    assert.equal(healed.length, 1);
    assert.equal(healed[0].runId, 'run-heal-optin-1');
    assert.equal(healed[0].stepId, 'h1');
    const ev = healed[0].evidence as { succeededWith: { strategy: string }; tried: string[]; verified: boolean };
    assert.deepEqual(ev.succeededWith, { ...ALT_TESTID });
    assert.deepEqual(ev.tried, ['css=".nope"', 'testId="login-btn"']);
    assert.equal(ev.verified, true);

    assert.equal(healing.length, 1, 'evidence returned for the server to persist as a proposal');
    assert.deepEqual(healing[0].evidence.succeededWith, { ...ALT_TESTID });
  });

  it('default (flag off): P0 behavior unchanged — no healing output', async () => {
    const store = new InMemoryRunStore();
    const events: RunEvent[] = [];
    const { status, healing } = await runTest(healRequest('run-heal-off-1'), stubDeps(store, events, ['--fail']));
    assert.equal(status, 'failed');
    assert.deepEqual(healing, []);
    assert.ok(!events.some((e) => (e.event as string) === STEP_HEALED_EVENT));
  });
});

// ---------------------------------------------------------------------------
// Part B — server API (real app + isolated SQLite)
// ---------------------------------------------------------------------------

type App = FastifyInstance;
let app: App;

const HEALING_DDL = `
CREATE TABLE IF NOT EXISTS "HealingProposal" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "testId" TEXT NOT NULL,
  "stepId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "fromLocator" TEXT NOT NULL,
  "toLocator" TEXT NOT NULL,
  "evidence" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdBy" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" DATETIME
)`;

function p2Definition(projectId: string) {
  return {
    schemaVersion: '1.0',
    id: 'test_p2',
    projectId,
    name: 'P2 flows',
    browser: 'chromium',
    baseUrl: FIXTURE_URL,
    steps: [
      { id: 'g1', type: 'goto', enabled: true, url: `${FIXTURE_URL}/fixture/login` },
      {
        id: 'f1',
        type: 'fill',
        enabled: true,
        target: { primary: { strategy: 'label', value: 'Password' } },
        value: '{{LOGIN_PASSWORD}}',
        sensitive: true,
      },
      {
        id: 'c1',
        type: 'click',
        enabled: true,
        target: {
          primary: { strategy: 'role', role: 'button', name: 'Missing' },
          alternatives: [
            { strategy: 'css', value: '.login-btn' },
            { strategy: 'testId', value: 'login-btn' },
          ],
        },
      },
      {
        id: 'f2',
        type: 'fill',
        enabled: true,
        target: { primary: { strategy: 'label', value: 'Email' } },
        value: 'tester@example.com',
      },
    ],
  };
}

before(async () => {
  await ensureIntegrationDb();
  // The shared integration DB predates the P2 schema wave and `prisma db push`
  // is owned by another agent's migration work — ensure the table locally so
  // this file is self-sufficient (CREATE TABLE IF NOT EXISTS is idempotent).
  const { PrismaClient } = await import('@prisma/client');
  const ddl = new PrismaClient();
  try {
    await ddl.$executeRawUnsafe(HEALING_DDL);
  } finally {
    await ddl.$disconnect();
  }
  app = await buildApp();
  // Routes are registered by buildApp() itself (apps/server/src/app.ts) —
  // no manual registration (that would declare every route twice).
});

after(async () => {
  await app.close();
});

async function makeProjectAndTest() {
  const p = await injectJson(app, 'POST', '/api/v1/projects', { name: 'p2-heal-suggest' });
  assert.equal(p.statusCode, 201);
  const projectId = (p.json() as { id: string }).id;
  const t = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
    name: 'p2',
    definitionJson: p2Definition(projectId),
  });
  assert.equal(t.statusCode, 201);
  return { projectId, testId: (t.json() as { id: string }).id };
}

describe('P2 healing proposals API', () => {
  it('creates pending proposals with dedupe; skips attempts with no winner', async () => {
    const { projectId, testId } = await makeProjectAndTest();
    const attempt = {
      stepId: 'c1',
      fromLocator: { strategy: 'role', role: 'button', name: 'Missing' },
      evidence: {
        tried: ['css=".login-btn"', 'testId="login-btn"'],
        succeededWith: { strategy: 'testId', value: 'login-btn' },
        matchCount: 1,
        preview: 'testId="login-btn"',
        verified: true,
        durationMs: 7,
        reason: 'locator-timeout',
      },
    };
    const first = await createHealingProposalsFromEvidence({
      testId,
      projectId,
      runId: 'run_p2_a',
      attempts: [attempt],
      createdBy: 'u_integration',
    });
    assert.deepEqual({ created: first.created, skipped: first.skipped }, { created: 1, skipped: 0 });

    const rerun = await createHealingProposalsFromEvidence({
      testId,
      projectId,
      runId: 'run_p2_b',
      attempts: [attempt, { stepId: 'c1', fromLocator: attempt.fromLocator, evidence: { tried: ['css=".x"'] } }],
    });
    assert.deepEqual(
      { created: rerun.created, skipped: rerun.skipped },
      { created: 0, skipped: 2 },
      'same pending triple dedupes; winner-less attempt skipped',
    );

    const listed = await injectJson(app, 'GET', `/api/v1/tests/${testId}/healing?status=pending`);
    assert.equal(listed.statusCode, 200);
    assert.equal((listed.json() as unknown[]).length, 1);
  });

  it('approve rewrites primary, demotes old primary, bumps version; reject is terminal', async () => {
    const { testId } = await makeProjectAndTest();
    const versionsBefore = (
      await injectJson(app, 'GET', `/api/v1/tests/${testId}/versions`)
    ).json() as unknown[];
    const mk = async (to: unknown) =>
      createHealingProposalsFromEvidence({
        testId,
        projectId: (await getTest(testId)).projectId,
        runId: 'run_p2_c',
        attempts: [
          {
            stepId: 'c1',
            fromLocator: { strategy: 'role', role: 'button', name: 'Missing' },
            evidence: { succeededWith: to, tried: [], verified: true },
          },
        ],
      });
    const { proposalIds } = await mk({ strategy: 'testId', value: 'login-btn' });
    const { proposalIds: second } = await mk({ strategy: 'css', value: '.login-btn' });

    const approved = await injectJson(app, 'POST', `/api/v1/healing/${proposalIds[0]}/approve`);
    assert.equal(approved.statusCode, 200);
    assert.equal((approved.json() as { versionNumber: number }).versionNumber, versionsBefore.length + 1);

    const def = JSON.parse(
      ((await injectJson(app, 'GET', `/api/v1/tests/${testId}`)).json() as { definitionJson: string }).definitionJson,
    ) as { steps: Array<{ id: string; target: { primary: unknown; alternatives: unknown[] } }> };
    const c1 = def.steps.find((s) => s.id === 'c1')!;
    assert.deepEqual(c1.target.primary, { strategy: 'testId', value: 'login-btn' });
    assert.deepEqual(c1.target.alternatives[0], { strategy: 'role', role: 'button', name: 'Missing' });

    const again = await injectJson(app, 'POST', `/api/v1/healing/${proposalIds[0]}/approve`);
    assert.equal(again.statusCode, 400);
    assert.equal((again.json() as { code: string }).code, 'VALIDATION_ERROR');

    // The second proposal is now stale (its fromLocator no longer matches).
    const stale = await injectJson(app, 'POST', `/api/v1/healing/${second[0]}/approve`);
    assert.equal(stale.statusCode, 400);

    const rejected = await injectJson(app, 'POST', `/api/v1/healing/${second[0]}/reject`);
    assert.equal(rejected.statusCode, 200);
    assert.equal((rejected.json() as { status: string }).status, 'rejected');

    const missing = await injectJson(app, 'POST', '/api/v1/healing/nope/reject');
    assert.equal(missing.statusCode, 404);
    assert.equal((missing.json() as { code: string }).code, 'NOT_FOUND');
  });

  async function getTest(id: string): Promise<{ projectId: string }> {
    const res = await injectJson(app, 'GET', `/api/v1/tests/${id}`);
    return res.json() as { projectId: string };
  }
});

describe('P2 suggested assertions (deterministic, no AI)', () => {
  it('buildSuggestions maps interaction steps to assertions', () => {
    const def = p2Definition('p');
    const sugs = buildSuggestions(def.steps as never);
    assert.deepEqual(
      sugs.map((s) => s.id),
      ['sug:g1:assertURL:1', 'sug:f1:assertValue:1', 'sug:c1:assertVisible:1', 'sug:f2:assertValue:1'],
    );
    assert.equal(sugs[1].masked, true, 'sensitive fill stays a masked {{VAR}} reference');
    assert.deepEqual((sugs[1].step as { expected: string }).expected, '{{LOGIN_PASSWORD}}');
    // click proposes the NEXT step's target (the click leads somewhere).
    assert.deepEqual((sugs[2].step as { target: unknown }).target, {
      primary: { strategy: 'label', value: 'Email' },
    });
  });

  it('POST generate + apply versions the definition; bad selections fail loudly', async () => {
    const { testId } = await makeProjectAndTest();
    const gen = await injectJson(app, 'POST', `/api/v1/tests/${testId}/suggestions`, {});
    assert.equal(gen.statusCode, 200);
    const body = gen.json() as { source: string; suggestions: Array<{ id: string; kind: string }> };
    assert.equal(body.source, 'definition');
    assert.equal(body.suggestions.length, 4);

    const versionsBefore = (
      await injectJson(app, 'GET', `/api/v1/tests/${testId}/versions`)
    ).json() as unknown[];
    const apply = await injectJson(app, 'POST', `/api/v1/tests/${testId}/suggestions/apply`, {
      suggestionIds: [body.suggestions[0].id, body.suggestions[1].id],
    });
    assert.equal(apply.statusCode, 200);
    assert.equal((apply.json() as { versionNumber: number }).versionNumber, versionsBefore.length + 1);

    const def = JSON.parse(
      ((await injectJson(app, 'GET', `/api/v1/tests/${testId}`)).json() as { definitionJson: string }).definitionJson,
    ) as { steps: Array<{ id: string; type: string }> };
    assert.deepEqual(
      def.steps.map((s) => `${s.id}:${s.type}`),
      [
        'g1:goto',
        'g1-assert-assertURL:assertURL',
        'f1:fill',
        'f1-assert-assertValue:assertValue',
        'c1:click',
        'f2:fill',
      ],
    );

    const badId = await injectJson(app, 'POST', `/api/v1/tests/${testId}/suggestions/apply`, {
      suggestionIds: ['sug:nope:assertURL:9'],
    });
    assert.equal(badId.statusCode, 400);
    assert.equal((badId.json() as { code: string }).code, 'VALIDATION_ERROR');

    const badIdx = await injectJson(app, 'POST', `/api/v1/tests/${testId}/suggestions/apply`, { indexes: [99] });
    assert.equal(badIdx.statusCode, 400);

    const both = await injectJson(app, 'POST', `/api/v1/tests/${testId}/suggestions/apply`, {
      suggestionIds: [body.suggestions[2].id],
      indexes: [2],
    });
    assert.equal(both.statusCode, 400);

    // position override: insert after an explicit anchor.
    const anchored = await injectJson(app, 'POST', `/api/v1/tests/${testId}/suggestions/apply`, {
      indexes: [2, 3],
      position: { afterStepId: 'f2' },
    });
    assert.equal(anchored.statusCode, 200);
    const def2 = JSON.parse(
      ((await injectJson(app, 'GET', `/api/v1/tests/${testId}`)).json() as { definitionJson: string }).definitionJson,
    ) as { steps: Array<{ id: string; type: string }> };
    const tail = def2.steps.slice(-3).map((s) => s.type);
    assert.deepEqual(tail, ['fill', 'assertVisible', 'assertValue']);
  });

  it('unknown recorder session is 404 (sessionId path, no browser needed)', async () => {
    const { testId } = await makeProjectAndTest();
    const res = await injectJson(app, 'POST', `/api/v1/tests/${testId}/suggestions`, { sessionId: 'sess_nope' });
    assert.equal(res.statusCode, 404);
  });
});
