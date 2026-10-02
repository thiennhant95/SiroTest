/**
 * Crash recovery (runner-spec.md + artifacts-reporting.md).
 *
 * If the runner process dies mid-run (power loss, OOM, `taskkill /F`),
 * in-flight runs stay `queued`/`running` in the DB forever unless
 * something settles them on the next boot. Call
 * `recoverIncompleteRuns(store)` at server/runner startup: every
 * non-terminal run is marked `failed` with a clear errorSummary, every
 * non-terminal step is marked `failed` (NOT deleted), and existing
 * artifacts under storage/runs/<run-id>/ are left untouched.
 *
 * Cancel path is different on purpose: user cancel -> run `cancelled`
 * + incomplete steps `skipped` (see cancelRun in run.ts and
 * settleIncompleteSteps in persist.ts).
 */

import { now, settleIncompleteSteps, type RunStore } from './persist.js';

export interface RecoveryReport {
  recoveredRuns: string[];
  recoveredSteps: number;
}

/** Mark all `queued`/`running` runs as `failed` after an abnormal teardown. */
export async function recoverIncompleteRuns(store: RunStore, listActive: () => Promise<string[]> | string[]): Promise<RecoveryReport> {
  const ids = typeof listActive === 'function' ? await listActive() : listActive;
  const report: RecoveryReport = { recoveredRuns: [], recoveredSteps: 0 };
  const at = now();
  for (const runId of ids) {
    const summary = await store.getSummary(runId);
    if (!summary) continue;
    if (summary.run.status !== 'queued' && summary.run.status !== 'running') continue;
    const settled = settleIncompleteSteps(summary.steps, 'failed', at);
    for (const s of settled) {
      const orig = summary.steps.find((o) => o.stepId === s.stepId);
      if (orig && orig.status !== s.status) {
        await store.updateStep(runId, s.stepId, {
          status: 'failed',
          finishedAt: s.finishedAt ?? at,
          durationMs: s.durationMs ?? 0,
          errorMessage: orig.errorMessage ?? 'Runner stopped before this step reported (crash recovery)',
        });
        report.recoveredSteps += 1;
      }
    }
    await store.updateRun(runId, {
      status: 'failed',
      finishedAt: at,
      errorSummary: summary.run.errorSummary ?? 'Runner stopped before this run finished (crash recovery — artifacts kept)',
    });
    report.recoveredRuns.push(runId);
  }
  return report;
}
