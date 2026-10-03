import type { ReusableAction } from '@vietvang/playwright-compiler';
import { loadProjectActions } from './actions.js';
import { db } from './db.js';
import { ApiError } from './errors.js';
import { createHealingProposalsFromEvidence } from './routes/healing.js';
import { decryptSecret } from './security.js';
import { resolveFilePaths } from './routes/files.js';

/**
 * Shared P1 run-input resolution (single-test runs, suite members, schedules).
 *
 * Every trigger path must resolve the SAME inputs so behavior never depends
 * on which endpoint started the run:
 * - `actions`: project callees for `callAction` inlining (empty when none).
 * - `filePaths`: fileId → absolute path for `upload` steps found in the
 *   definition AND in every project action body (compile would otherwise
 *   fail explicitly inside the worker; resolving here fails fast with 400).
 * - `storageStateJson`: ONLY when an explicit `profileId` is passed (no
 *   silent auto-apply — a run never picks up login state unasked).
 *
 * All problems throw ApiError(400) BEFORE any Run row executes: unknown
 * profile/file, cross-project references, env-bound profile mismatch.
 */
export interface ResolvedRunInputs {
  actions: ReusableAction[];
  filePaths?: Record<string, string>;
  storageStateJson?: string;
}

/** Collect `upload` step fileIds from a definition plus every action body. */
export function collectUploadFileIds(definition: unknown, actions: ReusableAction[]): string[] {
  const ids = new Set<string>();
  const scan = (steps: unknown): void => {
    if (!Array.isArray(steps)) return;
    for (const s of steps) {
      if (s === null || typeof s !== 'object') continue;
      const r = s as Record<string, unknown>;
      if (r['type'] === 'upload' && typeof r['fileId'] === 'string' && (r['fileId'] as string).length > 0) {
        ids.add(r['fileId'] as string);
      }
    }
  };
  scan((definition as { steps?: unknown } | null)?.steps);
  for (const a of actions) scan((a as { steps?: unknown })?.steps);
  return [...ids];
}

/**
 * Resolve an explicit auth profile selection into runner storageState JSON.
 * `undefined` (no selection) stays `undefined` — profiles never auto-apply.
 */
export async function resolveExplicitProfile(
  projectId: string,
  environmentId: string,
  profileId: string | undefined,
): Promise<string | undefined> {
  if (profileId === undefined) return undefined;
  const row = await db().authProfile.findUnique({ where: { id: profileId } });
  if (!row || row.projectId !== projectId) {
    throw new ApiError('VALIDATION_ERROR', `profileId '${profileId}' does not belong to this project`, 400);
  }
  if (row.environmentId !== null && row.environmentId !== environmentId) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `auth profile '${row.name}' is bound to a different environment`,
      400,
    );
  }
  let plain: string;
  try {
    plain = decryptSecret(row.stateEncrypted);
  } catch {
    throw new ApiError('VALIDATION_ERROR', `auth profile '${row.name}' cannot be decrypted (missing key?)`, 400);
  }
  try {
    JSON.parse(plain);
  } catch {
    throw new ApiError('VALIDATION_ERROR', `auth profile '${row.name}' holds corrupt storageState JSON`, 400);
  }
  return plain;
}

export async function resolveRunInputs(
  projectId: string,
  definition: unknown,
  opts: { environmentId: string; profileId?: string },
): Promise<ResolvedRunInputs> {
  const actions = await loadProjectActions(projectId);
  const fileIds = collectUploadFileIds(definition, actions);
  let filePaths: Record<string, string> | undefined;
  if (fileIds.length > 0) {
    try {
      filePaths = await resolveFilePaths(projectId, fileIds);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ApiError('VALIDATION_ERROR', `upload file resolution failed: ${message}`, 400);
    }
  }
  const storageStateJson = await resolveExplicitProfile(projectId, opts.environmentId, opts.profileId);
  return {
    actions,
    ...(filePaths !== undefined ? { filePaths } : {}),
    ...(storageStateJson !== undefined ? { storageStateJson } : {}),
  };
}

/** P2 healing outcome shape produced by runTest (runner/src/healing.ts). */
export interface RunHealingAttempt {
  stepId: string;
  fromLocator: unknown;
  evidence?: {
    tried?: string[];
    succeededWith?: unknown;
    matchCount?: number;
    preview?: string;
    verified?: boolean;
    durationMs?: number;
    reason?: string;
  };
}

/**
 * Persist `pending` healing proposals from a terminal run's healing evidence.
 * Best-effort and silent on failure: proposals are review aids, never load-
 * bearing for the run lifecycle itself.
 */
export async function maybeCreateHealingProposals(
  outcome: { status: string; runId: string; healing?: RunHealingAttempt[] },
  ctx: { testId: string; projectId: string; runId: string; createdBy?: string },
): Promise<void> {
  const attempts = Array.isArray(outcome?.healing) ? outcome.healing : [];
  if (attempts.length === 0) return;
  try {
    await createHealingProposalsFromEvidence({
      testId: ctx.testId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      attempts,
      ...(ctx.createdBy !== undefined ? { createdBy: ctx.createdBy } : {}),
    });
  } catch {
    // Review aids must never break run settlement.
  }
}
