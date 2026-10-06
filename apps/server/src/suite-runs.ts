/**
 * P1 — suite run orchestration (Suites/tags + Suite parallelism/retries).
 *
 * NOTE on the runner boundary (AGENTS.md §2, §5): the execution engine is
 * NOT changed — every test still executes via the P0 `runTest` lifecycle
 * (validate → resolve env → isolated workspace → compile → execute with the
 * custom reporter → stream WS → persist → cleanup). This module only
 * orchestrates at the server level:
 * - one `Run` row per suite member (suiteId + suiteRunId set, trigger
 *   'suite'), each enqueued through the EXISTING `runQueue` (capacity 2).
 *   Parallelism is therefore bounded by the P0 queue automatically;
 *   `parallel: 2` enqueues all members at once, `parallel: 1` chains them
 *   strictly sequentially (next starts only after the previous settles).
 * - retries: a member whose terminal status is `failed` is re-enqueued as a
 *   NEW attempt row (same suiteRunId, trigger 'suite-retry') up to N times
 *   (default 0 = no retries). Cancelled runs are never retried.
 */
import type { runTest as runTestFn, RunRequest } from '@playwright-studio/runner';
import { nanoid } from 'nanoid';
import { db } from './db.js';
import { stripServerPaths } from './security.js';
import { maybeCreateHealingProposals, resolveRunInputs } from './run-inputs.js';
import { notifyRunWebhooks } from './integrations.js';
import {
  broadcastRunEvent as broadcast,
  markQueuedEmittedByRoute,
  prismaRunStore,
  resolveRunVariables,
  runQueue,
  workerPublish,
} from './runner-store.js';

/** Suite-run ids cancelled via POST /suite-runs/:id/cancel: pending retries stop. */
const cancelledSuiteRuns = new Set<string>();

export function markSuiteRunCancelled(suiteRunId: string): void {
  cancelledSuiteRuns.add(suiteRunId);
}

export function isSuiteRunCancelled(suiteRunId: string): boolean {
  return cancelledSuiteRuns.has(suiteRunId);
}

/**
 * Suite executions accepted (202) but with no Run row yet. Only `parallel: 1`
 * has this window: rows are created progressively as the chain advances,
 * AFTER the 202 response. The registry lets GET /suite-runs/:id and
 * GET /suites/:sid/runs answer `queued` instead of 404-flashing, and lets
 * cancel land before the first row exists. Entries are consumed lazily: any
 * read that finds real rows for the suiteRunId drops the pending entry.
 */
export interface PendingSuiteRun {
  suiteId: string;
  projectId: string;
  testIds: string[];
  retries: number;
  parallel: number;
  createdAt: number;
}

const pendingSuiteRuns = new Map<string, PendingSuiteRun>();

export function registerPendingSuiteRun(suiteRunId: string, info: PendingSuiteRun): void {
  pendingSuiteRuns.set(suiteRunId, info);
}

export function getPendingSuiteRun(suiteRunId: string): PendingSuiteRun | undefined {
  return pendingSuiteRuns.get(suiteRunId);
}

export function consumePendingSuiteRun(suiteRunId: string): void {
  pendingSuiteRuns.delete(suiteRunId);
}

export function pendingRunsForSuite(suiteId: string): Array<{ suiteRunId: string } & PendingSuiteRun> {
  return [...pendingSuiteRuns.entries()]
    .filter(([, p]) => p.suiteId === suiteId)
    .map(([suiteRunId, p]) => ({ suiteRunId, ...p }));
}

export type SuiteBrowser = 'chromium' | 'firefox' | 'webkit';

export interface EnqueueSuiteMemberOptions {
  testId: string;
  projectId: string;
  definitionJson: string;
  environmentId: string;
  browser: SuiteBrowser;
  headed: boolean;
  trigger: 'suite' | 'suite-retry';
  suiteId: string;
  suiteRunId: string;
  triggeredBy: string;
  /** Remaining automatic retries if THIS attempt fails (0 = none). */
  retriesLeft: number;
  /** P1 wave-2: explicit auth profile (storage state); never auto-applied. */
  profileId?: string;
  /** P2 healing: try stored alternatives on locator failure (proposal-only). */
  healWithAlternatives?: boolean;
  /** P1 data-driven: suite-level selection (validated per member by the route). */
  datasetId?: string;
  /** Single 0-based row (requires datasetId). */
  rowIndex?: number;
}

type RunTest = typeof runTestFn;

/**
 * Create one Run row for a suite member and submit it to the shared queue.
 * Returns the first-attempt runId immediately (row creation only) plus a
 * `done` promise for the FINAL terminal status of this member line (after
 * all retries) — `done` never rejects. `parallel: 1` callers await `done`
 * before starting the next member; `parallel: 2` callers only await the
 * row creation and let the queue bound real concurrency.
 */
export async function enqueueSuiteMember(
  runTest: RunTest,
  opts: EnqueueSuiteMemberOptions,
): Promise<{ runId: string; done: Promise<string> }> {
  const run = await db().run.create({
    data: {
      projectId: opts.projectId,
      testId: opts.testId,
      environmentId: opts.environmentId,
      browser: opts.browser,
      status: 'queued',
      trigger: opts.trigger,
      suiteId: opts.suiteId,
      suiteRunId: opts.suiteRunId,
    },
  });
  broadcast('run.queued', run.id, { testId: opts.testId, suiteRunId: opts.suiteRunId });
  markQueuedEmittedByRoute(run.id);

  const done: Promise<string> = (async (): Promise<string> => {
    const definition = JSON.parse(opts.definitionJson) as RunRequest['test'];
    const { projectVariables, environmentVariables } = await resolveRunVariables(
      opts.projectId,
      opts.environmentId,
    );
    // Same P1 inputs as single-test runs: actions + upload files + explicit
    // profile (fail fast inside the worker lifecycle on bad references).
    const inputs = await resolveRunInputs(opts.projectId, definition, {
      environmentId: opts.environmentId,
      ...(opts.profileId !== undefined ? { profileId: opts.profileId } : {}),
    });
    const request: RunRequest = {
      runId: run.id,
      test: definition,
      projectId: opts.projectId,
      environmentId: opts.environmentId,
      browser: opts.browser,
      headed: opts.headed,
      ...(inputs.actions.length > 0 ? { actions: inputs.actions } : {}),
      ...(inputs.filePaths !== undefined ? { filePaths: inputs.filePaths } : {}),
      ...(inputs.storageStateJson !== undefined ? { storageStateJson: inputs.storageStateJson } : {}),
      // P2 healing is opt-in and proposal-only (never silently applied).
      ...(opts.healWithAlternatives === true ? { healWithAlternatives: true as const } : {}),
      // P1 data-driven selection (route-validated per member beforehand).
      ...(opts.datasetId !== undefined ? { datasetId: opts.datasetId } : {}),
      ...(opts.rowIndex !== undefined ? { rowIndex: opts.rowIndex } : {}),
      projectVariables,
      environmentVariables,
      trigger: opts.trigger,
      triggeredBy: opts.triggeredBy,
    };

    let terminal = 'failed';
    try {
      const outcome = await runQueue.submit(run.id, async () => {
        // A cancel that landed while queued must win: never resurrect a
        // settled run by executing it afterwards (same guard as runs.ts).
        const current = await prismaRunStore.getRun(run.id);
        if (current?.status === 'cancelled') return { status: 'cancelled' as const, runId: run.id };
        return runTest(request, { store: prismaRunStore, publish: workerPublish });
      });
      terminal = (outcome as { status?: string })?.status ?? terminal;
      // P2 healing proposals are review aids derived from terminal evidence.
      await maybeCreateHealingProposals(outcome, {
        testId: opts.testId,
        projectId: opts.projectId,
        runId: run.id,
        createdBy: opts.triggeredBy,
      });
    } catch (err: unknown) {
      // Last-resort guard against a worker crash escaping the lifecycle.
      const message = err instanceof Error ? err.message : String(err);
      await prismaRunStore.updateRun(run.id, {
        status: 'failed',
        finishedAt: Date.now(),
        errorSummary: stripServerPaths(`Worker crashed before settling: ${message}`),
      });
      terminal = 'failed';
    }

    // Retry orchestration: only genuine failures, never cancellations, never
    // after the whole suite-run was cancelled, and only while budget remains.
    // The retry is a NEW Run row (audit trail preserved) with trigger
    // 'suite-retry'; its terminal status becomes this member's final one.
    if (terminal === 'failed' && opts.retriesLeft > 0 && !isSuiteRunCancelled(opts.suiteRunId)) {
      const retry = await enqueueSuiteMember(runTest, {
        ...opts,
        trigger: 'suite-retry',
        retriesLeft: opts.retriesLeft - 1,
      });
      return retry.done;
    }
    // Member FINAL outcome (after retries — the retry branch returned above):
    // generic webhook fan-out for this member line.
    {
      const settled = await prismaRunStore.getRun(run.id).catch(() => null);
      const memberTest = await db().test.findUnique({ where: { id: opts.testId }, select: { name: true } }).catch(() => null);
      void notifyRunWebhooks({
        projectId: opts.projectId,
        event: terminal === 'passed' ? 'run.passed' : terminal === 'cancelled' ? 'run.cancelled' : 'run.failed',
        runId: run.id, status: terminal, trigger: opts.trigger, suiteRunId: opts.suiteRunId,
        testName: memberTest?.name ?? undefined,
        errorSummary: settled?.errorSummary ?? null,
      });
    }
    return terminal;
  })().catch(() => 'failed');
  return { runId: run.id, done };
}

/** Mint a suite execution-group id (one `suiteRunId` per POST /suites/:sid/runs). */
export function newSuiteRunId(): string {
  return `sr_${nanoid(12)}`;
}
