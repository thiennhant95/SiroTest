/**
 * Server-side wiring for `@playwright-studio/runner` (P0).
 *
 * - `PrismaRunStore`: the runner's `RunStore` interface backed by the
 *   server's Prisma/SQLite tables (09-database/schema.md). The DB stays the
 *   source of truth; WS events are informational only.
 * - `runQueue`: single `RunQueue(2)` gate (P0 default 1–2 concurrent runs).
 * - `workerPublish`: runner `EventPublisher` fanned out to WS via the
 *   `ws/events.ts` builders (`runEvent`), scoped by `runId`.
 * - `resolveRunVariables`: project → environment variable resolution with
 *   at-rest decryption (`security.ts`); secrets stay out of code/logs/events.
 * - `recoverIncompleteRunsOnBoot`: crash-recovery entry point for server boot.
 */
import {
  buildEvent,
  recoverIncompleteRuns,
  RunQueue,
  type ArtifactRecord,
  type RunEvent,
  type RunRecord,
  type RunStatus,
  type RunStore,
  type StepRecord,
  type StepStatus,
  type VariableDef,
} from '@playwright-studio/runner';
import { db } from './db.js';
import { decryptSecret, stripServerPaths } from './security.js';
import { runEvent, type WsSend } from './ws/events.js';

const TERMINAL_RUN_STATUS = new Set<RunStatus>(['passed', 'failed', 'cancelled']);

function toDate(ms: number | undefined): Date | undefined {
  return ms === undefined ? undefined : new Date(ms);
}

function toMs(d: Date | null | undefined): number | undefined {
  if (!d) return undefined;
  const ms = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function asRunStatus(s: string): RunStatus {
  if (s === 'queued' || s === 'running' || s === 'passed' || s === 'failed' || s === 'cancelled') return s;
  return 'failed';
}

function asStepStatus(s: string): StepStatus {
  if (s === 'pending' || s === 'running' || s === 'passed' || s === 'failed' || s === 'skipped') return s;
  return 'failed';
}

type DbRun = {
  id: string;
  projectId: string;
  testId: string;
  environmentId: string | null;
  browser: string;
  status: string;
  trigger: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  errorSummary: string | null;
};

/** Prisma row → runner `RunRecord` (Date ↔ epoch-ms at the boundary). */
function toRunRecord(r: DbRun): RunRecord {
  return {
    id: r.id,
    projectId: r.projectId,
    testId: r.testId,
    ...(r.environmentId ? { environmentId: r.environmentId } : {}),
    browser: (r.browser === 'firefox' || r.browser === 'webkit' ? r.browser : 'chromium') as RunRecord['browser'],
    status: asRunStatus(r.status),
    ...(r.trigger ? { trigger: r.trigger } : {}),
    ...(toMs(r.startedAt) !== undefined ? { startedAt: toMs(r.startedAt) } : {}),
    ...(toMs(r.finishedAt) !== undefined ? { finishedAt: toMs(r.finishedAt) } : {}),
    ...(r.durationMs !== null ? { durationMs: r.durationMs } : {}),
    ...(r.errorSummary ? { errorSummary: r.errorSummary } : {}),
  };
}

/**
 * Prisma-backed `RunStore` for the runner engine.
 *
 * Terminal-state guard: once a run is `passed`/`failed`/`cancelled` (e.g. a
 * user cancel landed first), late `queued`/`running` patches are dropped so a
 * settled run can never be resurrected by an in-flight worker. Cancellation
 * itself (`running` → `cancelled`) and failure settlement always apply.
 */
export class PrismaRunStore implements RunStore {
  async createRun(run: RunRecord): Promise<void> {
    await db().run.upsert({
      where: { id: run.id },
      update: {},
      create: {
        id: run.id,
        projectId: run.projectId,
        testId: run.testId,
        environmentId: run.environmentId ?? null,
        browser: run.browser,
        status: run.status,
        trigger: run.trigger ?? 'manual',
        ...(toDate(run.startedAt) ? { startedAt: toDate(run.startedAt) } : {}),
        ...(toDate(run.finishedAt) ? { finishedAt: toDate(run.finishedAt) } : {}),
        ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
        ...(run.errorSummary ? { errorSummary: run.errorSummary } : {}),
      },
    });
  }

  async updateRun(id: string, patch: Partial<RunRecord>): Promise<RunRecord> {
    const current = await db().run.findUnique({ where: { id } });
    if (!current) throw new Error(`Run not found: ${id}`);
    const next = { ...patch };
    if (
      TERMINAL_RUN_STATUS.has(asRunStatus(current.status)) &&
      next.status !== undefined &&
      (next.status === 'queued' || next.status === 'running')
    ) {
      delete next.status;
      delete next.startedAt;
    }
    const updated = await db().run.update({
      where: { id },
      data: {
        ...(next.projectId ? { projectId: next.projectId } : {}),
        ...(next.testId ? { testId: next.testId } : {}),
        ...(next.environmentId !== undefined ? { environmentId: next.environmentId ?? null } : {}),
        ...(next.browser ? { browser: next.browser } : {}),
        ...(next.status ? { status: next.status } : {}),
        ...(next.trigger !== undefined ? { trigger: next.trigger ?? 'manual' } : {}),
        ...(next.startedAt !== undefined ? { startedAt: toDate(next.startedAt) ?? null } : {}),
        ...(next.finishedAt !== undefined ? { finishedAt: toDate(next.finishedAt) ?? null } : {}),
        ...(next.durationMs !== undefined ? { durationMs: next.durationMs ?? null } : {}),
        ...(next.errorSummary !== undefined ? { errorSummary: next.errorSummary ?? null } : {}),
      },
    });
    return toRunRecord(updated as DbRun);
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const run = await db().run.findUnique({ where: { id } });
    return run ? toRunRecord(run as DbRun) : null;
  }

  async upsertStep(step: StepRecord): Promise<void> {
    await db().runStep.upsert({
      where: { id: step.id },
      update: {
        runId: step.runId,
        stepId: step.stepId,
        sortOrder: step.sortOrder,
        status: step.status,
        startedAt: toDate(step.startedAt) ?? null,
        finishedAt: toDate(step.finishedAt) ?? null,
        durationMs: step.durationMs ?? null,
        errorMessage: step.errorMessage ?? null,
        screenshotPath: step.screenshotPath ?? null,
      },
      create: {
        id: step.id,
        runId: step.runId,
        stepId: step.stepId,
        sortOrder: step.sortOrder,
        status: step.status,
        startedAt: toDate(step.startedAt) ?? null,
        finishedAt: toDate(step.finishedAt) ?? null,
        durationMs: step.durationMs ?? null,
        errorMessage: step.errorMessage ?? null,
        screenshotPath: step.screenshotPath ?? null,
      },
    });
  }

  async updateStep(runId: string, stepId: string, patch: Partial<StepRecord>): Promise<void> {
    const existing = await db().runStep.findFirst({ where: { runId, stepId } });
    if (!existing) throw new Error(`Step not found: ${runId}/${stepId}`);
    await db().runStep.update({
      where: { id: existing.id },
      data: {
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.startedAt !== undefined ? { startedAt: toDate(patch.startedAt) ?? null } : {}),
        ...(patch.finishedAt !== undefined ? { finishedAt: toDate(patch.finishedAt) ?? null } : {}),
        ...(patch.durationMs !== undefined ? { durationMs: patch.durationMs ?? null } : {}),
        ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage ?? null } : {}),
        ...(patch.screenshotPath !== undefined ? { screenshotPath: patch.screenshotPath ?? null } : {}),
      },
    });
  }

  async addArtifact(artifact: ArtifactRecord): Promise<void> {
    await db().artifact.upsert({
      where: { id: artifact.id },
      update: {
        runId: artifact.runId,
        type: artifact.type,
        path: artifact.path,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes ?? null,
      },
      create: {
        id: artifact.id,
        runId: artifact.runId,
        type: artifact.type,
        path: artifact.path,
        mimeType: artifact.mimeType ?? null,
        sizeBytes: artifact.sizeBytes ?? null,
      },
    });
  }

  async getSummary(runId: string) {
    const run = await db().run.findUnique({ where: { id: runId } });
    if (!run) return null;
    const steps = await db().runStep.findMany({ where: { runId }, orderBy: { sortOrder: 'asc' } });
    const artifacts = await db().artifact.findMany({ where: { runId } });
    return {
      run: toRunRecord(run as DbRun),
      steps: steps.map((s) => ({
        id: s.id,
        runId: s.runId,
        stepId: s.stepId,
        sortOrder: s.sortOrder,
        status: asStepStatus(s.status),
        ...(toMs(s.startedAt) !== undefined ? { startedAt: toMs(s.startedAt) } : {}),
        ...(toMs(s.finishedAt) !== undefined ? { finishedAt: toMs(s.finishedAt) } : {}),
        ...(s.durationMs !== null ? { durationMs: s.durationMs } : {}),
        ...(s.errorMessage ? { errorMessage: s.errorMessage } : {}),
        ...(s.screenshotPath ? { screenshotPath: s.screenshotPath } : {}),
        timeoutMs: 0,
      })) as StepRecord[],
      artifacts: artifacts.map((a) => ({
        id: a.id,
        runId: a.runId,
        type: a.type as ArtifactRecord['type'],
        path: a.path,
        mimeType: a.mimeType ?? '',
        ...(a.sizeBytes !== null ? { sizeBytes: a.sizeBytes } : {}),
      })) as ArtifactRecord[],
    };
  }
}

export const prismaRunStore = new PrismaRunStore();

/** P0 concurrency gate: max 2 concurrent runs per host (runner-spec.md). */
export const runQueue = new RunQueue(2);

/**
 * `run.queued` events already emitted synchronously by the POST route are
 * tracked here so the worker's own lifecycle `run.queued` is not fanned out
 * twice. Every other event passes through untouched.
 */
const queuedEmittedByRoute = new Set<string>();

export function markQueuedEmittedByRoute(runId: string): void {
  queuedEmittedByRoute.add(runId);
}

function wsSend(): WsSend | null {
  const send = (globalThis as { __vvWsBroadcast?: WsSend }).__vvWsBroadcast;
  return send ?? null;
}

/** Route-side broadcast through the `ws/events.ts` builder (scoped by runId). */
export function broadcastRunEvent(
  type: Parameters<typeof runEvent>[1],
  runId: string,
  extra: Record<string, unknown> = {},
): void {
  const send = wsSend();
  if (send) runEvent(send, type, runId, extra);
}

/** Runner `EventPublisher` wired to the server WS fan-out. */
export function workerPublish(evt: RunEvent): void {
  if (evt.event === 'run.queued' && queuedEmittedByRoute.has(evt.runId)) {
    queuedEmittedByRoute.delete(evt.runId);
    return;
  }
  const send = wsSend();
  if (!send) return;
  const { runId, stepId, status, durationMs, error } = evt;
  runEvent(send, evt.event, runId, {
    ...(stepId !== undefined ? { stepId } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(error !== undefined ? { error: stripServerPaths(error) } : {}),
  });
}

/** Re-emit a runner event object through the WS builders (cancel fallback). */
export function publishRunnerEvent(evt: RunEvent): void {
  workerPublish(evt);
}

export { buildEvent };

/**
 * Resolve DB variables for a run (project → environment override).
 * Secret cells are decrypted at run time via `security.ts`; plaintext never
 * lands in generated code, logs, WS events or result JSON (runner redacts).
 */
export async function resolveRunVariables(
  projectId: string,
  environmentId: string,
): Promise<{ projectVariables: VariableDef[]; environmentVariables: VariableDef[] }> {
  const rows = await db().variable.findMany({ where: { projectId } });
  const toDef = (r: { key: string; valueEncrypted: string; isSecret: boolean }): VariableDef => ({
    key: r.key,
    value: decryptSecret(r.valueEncrypted),
    isSecret: r.isSecret,
  });
  return {
    projectVariables: rows.filter((r) => r.environmentId === null).map(toDef),
    environmentVariables: rows.filter((r) => r.environmentId === environmentId).map(toDef),
  };
}

/**
 * Crash recovery at boot (runner-spec.md): every `queued`/`running` row left
 * behind by an abnormal teardown becomes `failed` with an explicit message;
 * non-terminal steps become `failed` (never deleted); existing artifacts are
 * kept. Cancel semantics are untouched (`cancelled` + `skipped`).
 */
export async function recoverIncompleteRunsOnBoot(): Promise<{ recoveredRuns: string[]; recoveredSteps: number }> {
  const stale = await db().run.findMany({
    where: { status: { in: ['queued', 'running'] } },
    select: { id: true },
  });
  if (stale.length === 0) return { recoveredRuns: [], recoveredSteps: 0 };
  return recoverIncompleteRuns(
    prismaRunStore,
    () => stale.map((r) => r.id),
  );
}
