/**
 * Artifact retention (artifacts-reporting.md).
 *
 * P0 default 14-30 days, configurable via ARTIFACT_RETENTION_DAYS.
 * The filesystem scan lives in scripts/cleanup-artifacts.mjs (plain node,
 * no deps, runnable with `pnpm cleanup`); this module holds the pure,
 * unit-testable selection rule so both the script and tests share it.
 */

export interface RetentionCandidate {
  runId: string;
  /** mtime of the run artifact dir (ms epoch) */
  mtimeMs: number;
}

export interface RetentionDecision {
  runId: string;
  ageDays: number;
  expired: boolean;
}

export function retentionDaysFromEnv(env: NodeJS.ProcessEnv = process.env, fallback = 30): number {
  const raw = env.ARTIFACT_RETENTION_DAYS ?? env.RETENTION_DAYS;
  const n = raw === undefined ? NaN : Number(raw);
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  return fallback;
}

/** Split candidates into keep/expired by age. `nowMs` injectable for tests. */
export function selectExpiredRuns(
  candidates: RetentionCandidate[],
  retentionDays: number,
  nowMs: number = Date.now(),
): RetentionDecision[] {
  const cutoffMs = retentionDays * 24 * 60 * 60 * 1000;
  return candidates.map((c) => {
    const ageDays = (nowMs - c.mtimeMs) / (24 * 60 * 60 * 1000);
    return { runId: c.runId, ageDays: Math.max(0, ageDays), expired: nowMs - c.mtimeMs > cutoffMs };
  });
}
