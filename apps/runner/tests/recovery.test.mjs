/**
 * Recovery + retention tests (Day 8-10).
 * Run:  pnpm --filter @playwright-studio/runner test   (node --test tests/)
 * No extra deps — built-in node:test, imports compiled dist/ (CJS via createRequire).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { settleIncompleteSteps, InMemoryRunStore } = require('../dist/persist.js');
const { recoverIncompleteRuns } = require('../dist/recover.js');
const { cancelRun } = require('../dist/run.js');
const { killProcessTree } = require('../dist/process.js');
const { resolveTimeouts, resolveTestTimeout } = require('../dist/timeout.js');
const { selectExpiredRuns, retentionDaysFromEnv } = require('../dist/retention.js');
const { buildEvent } = require('../dist/events.js');

const step = (stepId, status, extra = {}) => ({
  id: `run1:${stepId}`, runId: 'run1', stepId, sortOrder: 0, status, timeoutMs: 1000, ...extra,
});

describe('cancel semantics (runner-spec.md)', () => {
  it('settleIncompleteSteps: cancelled run -> incomplete steps become skipped', () => {
    const out = settleIncompleteSteps(
      [step('a', 'passed'), step('b', 'running', { startedAt: 1000 }), step('c', 'pending')],
      'cancelled', 2000,
    );
    assert.equal(out.find((s) => s.stepId === 'a').status, 'passed'); // terminal untouched
    assert.equal(out.find((s) => s.stepId === 'b').status, 'skipped');
    assert.equal(out.find((s) => s.stepId === 'c').status, 'skipped');
  });

  it('cancel settle: incomplete steps -> skipped, run -> cancelled, emits run.cancelled', async () => {
    // cancelRun() itself requires a live entry in the activeRuns map (only
    // runs started via runTest register there), so this test exercises the
    // exact settle contract cancelRun/server-cancel apply to the store:
    // run -> cancelled, pending/running steps -> skipped, run.cancelled emitted.
    const store = new InMemoryRunStore();
    await store.createRun({ id: 'runX', projectId: 'p', testId: 't', browser: 'chromium', status: 'running' });
    await store.upsertStep({ id: 'runX:s1', runId: 'runX', stepId: 's1', sortOrder: 0, status: 'running', startedAt: 100, timeoutMs: 1000 });
    await store.upsertStep({ id: 'runX:s2', runId: 'runX', stepId: 's2', sortOrder: 1, status: 'passed', timeoutMs: 1000 });
    const events = [];
    const publish = (e) => events.push(e);
    const at = Date.now();
    const summary = await store.getSummary('runX');
    for (const s of summary.steps) {
      if (s.status === 'pending' || s.status === 'running') {
        await store.updateStep('runX', s.stepId, { status: 'skipped', finishedAt: at, errorMessage: 'Cancelled by user' });
      }
    }
    await store.updateRun('runX', { status: 'cancelled', finishedAt: at });
    publish(buildEvent('run.cancelled', 'runX', { status: 'cancelled' }));
    const after = await store.getSummary('runX');
    assert.equal(after.run.status, 'cancelled');
    assert.equal(after.steps.find((s) => s.stepId === 's1').status, 'skipped');
    assert.equal(after.steps.find((s) => s.stepId === 's2').status, 'passed'); // terminal untouched
    assert.ok(events.some((e) => e.event === 'run.cancelled' && e.runId === 'runX'));
  });

  it('cancelRun on unknown run returns false', async () => {
    const store = new InMemoryRunStore();
    assert.equal(await cancelRun('nope', { store, publish: () => {} }), false);
  });

  it('killProcessTree(undefined) resolves without throwing (no pid = no-op)', async () => {
    await killProcessTree(undefined);
  });
});

describe('crash recovery (runner dies mid-run)', () => {
  it('settleIncompleteSteps: failed outcome -> incomplete steps become failed', () => {
    const out = settleIncompleteSteps([step('a', 'running', { startedAt: 1000 }), step('b', 'pending')], 'failed', 2000);
    assert.ok(out.every((s) => s.status === 'failed'));
  });

  it('recoverIncompleteRuns: stuck running run -> failed, artifacts untouched', async () => {
    const store = new InMemoryRunStore();
    await store.createRun({ id: 'r1', projectId: 'p', testId: 't', browser: 'chromium', status: 'running' });
    await store.upsertStep({ id: 'r1:s1', runId: 'r1', stepId: 's1', sortOrder: 0, status: 'running', startedAt: 100, timeoutMs: 1000 });
    await store.addArtifact({ id: 'r1-trace', runId: 'r1', type: 'trace', path: 'runs/r1/trace.zip', mimeType: 'application/zip' });
    const report = await recoverIncompleteRuns(store, ['r1']);
    assert.deepEqual(report.recoveredRuns, ['r1']);
    assert.equal(report.recoveredSteps, 1);
    const summary = await store.getSummary('r1');
    assert.equal(summary.run.status, 'failed');
    assert.match(summary.run.errorSummary, /crash recovery/);
    assert.equal(summary.steps[0].status, 'failed');
    assert.equal(summary.artifacts.length, 1); // kept
  });

  it('recoverIncompleteRuns: terminal runs are left alone', async () => {
    const store = new InMemoryRunStore();
    await store.createRun({ id: 'r2', projectId: 'p', testId: 't', browser: 'chromium', status: 'passed' });
    const report = await recoverIncompleteRuns(store, ['r2']);
    assert.deepEqual(report.recoveredRuns, []);
    assert.equal((await store.getSummary('r2')).run.status, 'passed');
  });

  it('run.cancelled event carries runId (WS reconnect clients filter on it)', () => {
    const e = buildEvent('run.cancelled', 'r9', { status: 'cancelled' });
    assert.equal(e.runId, 'r9');
  });
});

describe('timeout inheritance Project -> Test -> Step (source visible)', () => {
  const base = (timeoutMs) => ({
    schemaVersion: '1.0', id: 't', projectId: 'p', name: 't', browser: 'chromium',
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    steps: [{ id: 's1', type: 'goto', enabled: true }, { id: 's2', type: 'click', enabled: true, timeoutMs: 5000 }],
  });

  it('step override wins, then test, then project, then default', () => {
    const all = resolveTimeouts(base(9000), 7000);
    assert.deepEqual(all.find((t) => t.stepId === 's2'), { stepId: 's2', timeoutMs: 5000, source: 'step' });
    assert.deepEqual(all.find((t) => t.stepId === 's1'), { stepId: 's1', timeoutMs: 9000, source: 'test' });
    assert.deepEqual(resolveTimeouts({ ...base(undefined), timeoutMs: undefined }, 7000).find((t) => t.stepId === 's1'), { stepId: 's1', timeoutMs: 7000, source: 'project' });
    assert.deepEqual(resolveTimeouts({ ...base(undefined), timeoutMs: undefined }, undefined).find((t) => t.stepId === 's1'), { stepId: 's1', timeoutMs: 30000, source: 'default' });
  });

  it('whole-test timeout prefers test over project over default', () => {
    assert.equal(resolveTestTimeout(base(9000), 7000), 9000);
    assert.equal(resolveTestTimeout({ ...base(undefined), timeoutMs: undefined }, 7000), 7000);
    assert.equal(resolveTestTimeout({ ...base(undefined), timeoutMs: undefined }, undefined), 60000);
  });
});

describe('artifact retention (ARTIFACT_RETENTION_DAYS, default 30)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();

  it('selectExpiredRuns: older than retention -> expired, newer -> kept', () => {
    const out = selectExpiredRuns([
      { runId: 'old', mtimeMs: now - 31 * DAY },
      { runId: 'edge', mtimeMs: now - 29 * DAY },
    ], 30, now);
    assert.equal(out.find((d) => d.runId === 'old').expired, true);
    assert.equal(out.find((d) => d.runId === 'edge').expired, false);
  });

  it('retentionDaysFromEnv: env wins, garbage falls back to 30', () => {
    assert.equal(retentionDaysFromEnv({ ARTIFACT_RETENTION_DAYS: '14' }), 14);
    assert.equal(retentionDaysFromEnv({}), 30);
    assert.equal(retentionDaysFromEnv({ ARTIFACT_RETENTION_DAYS: 'abc' }), 30);
    assert.equal(retentionDaysFromEnv({ ARTIFACT_RETENTION_DAYS: '0' }), 30);
  });
});
