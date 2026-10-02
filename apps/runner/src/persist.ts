/**
 * Step 7/8 — Persist status/duration/error/artifact metadata.
 * Shapes mirror 09-database/schema.md tables: runs, run_steps, artifacts.
 * P0 ships an in-memory store; the Prisma/SQLite implementation uses the
 * same interface (table/column names kept PostgreSQL-compatible).
 */

import type { ArtifactRecord, RunRecord, RunStatus, StepRecord, StepStatus } from './types.js';

export interface RunStore {
  createRun(run: RunRecord): Promise<void>;
  updateRun(id: string, patch: Partial<RunRecord>): Promise<RunRecord>;
  getRun(id: string): Promise<RunRecord | null>;
  upsertStep(step: StepRecord): Promise<void>;
  updateStep(runId: string, stepId: string, patch: Partial<StepRecord>): Promise<void>;
  addArtifact(artifact: ArtifactRecord): Promise<void>;
  getSummary(runId: string): Promise<{ run: RunRecord; steps: StepRecord[]; artifacts: ArtifactRecord[] } | null>;
}

export function now(): number {
  return Date.now();
}

export function terminalRunStatusOf(failed: boolean, cancelled: boolean): RunStatus {
  if (cancelled) return 'cancelled';
  return failed ? 'failed' : 'passed';
}

export class InMemoryRunStore implements RunStore {
  private runs = new Map<string, RunRecord>();
  private steps = new Map<string, Map<string, StepRecord>>();
  private artifacts = new Map<string, ArtifactRecord[]>();

  async createRun(run: RunRecord): Promise<void> {
    this.runs.set(run.id, { ...run });
    this.steps.set(run.id, new Map());
    this.artifacts.set(run.id, []);
  }

  async updateRun(id: string, patch: Partial<RunRecord>): Promise<RunRecord> {
    const current = this.runs.get(id);
    if (!current) throw new Error(`Run not found: ${id}`);
    const next = { ...current, ...patch, id };
    this.runs.set(id, next);
    return next;
  }

  async getRun(id: string): Promise<RunRecord | null> {
    return this.runs.get(id) ?? null;
  }

  async upsertStep(step: StepRecord): Promise<void> {
    let perRun = this.steps.get(step.runId);
    if (!perRun) {
      perRun = new Map();
      this.steps.set(step.runId, perRun);
    }
    perRun.set(step.stepId, { ...step });
  }

  async updateStep(runId: string, stepId: string, patch: Partial<StepRecord>): Promise<void> {
    const perRun = this.steps.get(runId);
    const current = perRun?.get(stepId);
    if (!current) throw new Error(`Step not found: ${runId}/${stepId}`);
    perRun!.set(stepId, { ...current, ...patch, runId, stepId });
  }

  async addArtifact(artifact: ArtifactRecord): Promise<void> {
    const list = this.artifacts.get(artifact.runId) ?? [];
    list.push({ ...artifact });
    this.artifacts.set(artifact.runId, list);
  }

  async getSummary(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return null;
    const steps = [...(this.steps.get(runId)?.values() ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
    return { run, steps, artifacts: this.artifacts.get(runId) ?? [] };
  }
}

/** Mark every non-terminal step of a run after an abnormal teardown (cancel/crash). */
export function settleIncompleteSteps(
  steps: StepRecord[],
  outcome: 'cancelled' | 'failed',
  at: number,
): StepRecord[] {
  // Step enum has no 'cancelled': cancelled runs leave incomplete steps 'skipped'.
  const status: StepStatus = outcome === 'cancelled' ? 'skipped' : 'failed';
  return steps.map((s) =>
    s.status === 'passed' || s.status === 'failed' || s.status === 'skipped'
      ? s
      : { ...s, status, finishedAt: s.finishedAt ?? at, durationMs: s.durationMs ?? (s.startedAt ? at - s.startedAt : 0) },
  );
}
