import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { requireWriteAccessToProject } from '../rbac.js';
import { ApiError } from '../errors.js';
import { validateDefinitionForStore } from '../security.js';

/**
 * P2 — explicit, reviewable locator healing (ADR-003, ADR-005, 05-locator).
 *
 * A `HealingProposal` is created when a stored alternative locator succeeds
 * where the primary failed. It NEVER applies silently: a human approves
 * (rewrites the step primary, demotes the old primary to the head of
 * `alternatives`, mints a new test version) or rejects it.
 *
 * WIRING (owner: server wiring — this file is new and NOT yet registered in
 * `apps/server/src/app.ts`, which is frozen for this task):
 *   1. Register: `await v1.register(healingRoutes)` inside the `/api/v1`
 *      block of `buildApp()` in `app.ts` (one line, same as `testRoutes`).
 *   2. Proposal creation on run terminal: in `routes/runs.ts`, after the
 *      queued worker settles a run, call
 *      `createHealingProposalsFromEvidence({ testId, projectId, runId,
 *      attempts: result.healing, createdBy })` — `result.healing` is the
 *      `healing: HealAttempt[]` array returned by `runTest()` when the run
 *      was triggered with `healWithAlternatives: true`. (Passing the flag
 *      from `POST /tests/:id/runs` needs `healWithAlternatives` added to
 *      `runCreate` in `schemas.ts` — also frozen here, default stays false.)
 *   3. WS `step.healed` passthrough: `runner-store.ts workerPublish` forwards
 *      only P0 fields; add `step.healed` to the `runEvent` union in
 *      `ws/events.ts` and forward `evidence` (3 lines, additive — P0 contract
 *      untouched). Until then the runner still emits the event to its own
 *      publisher and full evidence travels in the `runTest()` return value.
 */

// ---------------------------------------------------------------------------
// Colocated zod schemas (route boundary shapes only)
// ---------------------------------------------------------------------------

const testIdParam = z.object({ id: z.string().min(1) });

const proposalIdParam = z.object({ pid: z.string().min(1) });

const healingListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending'),
});

const locatorCandidate = z.record(z.unknown());

const healAttemptInput = z.object({
  stepId: z.string().min(1),
  fromLocator: locatorCandidate,
  evidence: z
    .object({
      tried: z.array(z.string()).optional(),
      succeededWith: locatorCandidate.optional(),
      matchCount: z.number().int().nonnegative().optional(),
      preview: z.string().optional(),
      verified: z.boolean().optional(),
      durationMs: z.number().optional(),
      reason: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

function parseOrThrowLocal<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ApiError('VALIDATION_ERROR', 'Invalid request payload', 400, r.error.flatten());
  }
  return r.data;
}

// ---------------------------------------------------------------------------
// Small pure helpers (exported for tests)
// ---------------------------------------------------------------------------

const KNOWN_STRATEGIES: ReadonlySet<string> = new Set([
  'role',
  'label',
  'placeholder',
  'testId',
  'text',
  'css',
  'xpath',
]);

/** Deterministic JSON for compare/dedupe (shallow, sorted keys). */
export function stableLocatorKey(locator: unknown): string {
  if (locator === null || locator === undefined) return String(locator);
  if (typeof locator !== 'object' || Array.isArray(locator)) return JSON.stringify(locator);
  const entries = Object.entries(locator as Record<string, unknown>)
    .map(([k, v]) => [k, typeof v === 'object' ? stableLocatorKey(v) : JSON.stringify(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(',')}}`;
}

/** Minimal LocatorCandidate shape check (strategy + required payload). */
export function assertLocatorShape(locator: unknown, what: string): asserts locator is Record<string, unknown> {
  const c = (locator ?? {}) as Record<string, unknown>;
  if (typeof c['strategy'] !== 'string' || !KNOWN_STRATEGIES.has(c['strategy'] as string)) {
    throw new ApiError('VALIDATION_ERROR', `${what} has unknown locator strategy`, 400, { locator });
  }
  const needsValue =
    c['strategy'] === 'label' ||
    c['strategy'] === 'placeholder' ||
    c['strategy'] === 'testId' ||
    c['strategy'] === 'text' ||
    c['strategy'] === 'css' ||
    c['strategy'] === 'xpath';
  if (needsValue && typeof c['value'] !== 'string') {
    throw new ApiError('VALIDATION_ERROR', `${what} is missing its string 'value'`, 400, { locator });
  }
  if (c['strategy'] === 'role' && typeof c['role'] !== 'string') {
    throw new ApiError('VALIDATION_ERROR', `${what} is missing its string 'role'`, 400, { locator });
  }
}

/** Project membership for routes whose params carry no resolvable project. */
async function requireTestProjectAccess(req: FastifyRequest, projectId: string): Promise<void> {
  const user = req.user;
  if (!user) throw new ApiError('FORBIDDEN', 'Missing credentials', 403);
  const userRow = await db().user.findUnique({ where: { id: user.id } });
  if (userRow?.role === 'admin') return;
  const member = await db().projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: user.id } },
  });
  if (!member) throw new ApiError('FORBIDDEN', `No access to project ${projectId}`, 403);
}

/** Same storability gate as PATCH /tests/:id (custom code stays rejected). */
function assertStorableDefinition(definitionJson: unknown): void {
  const issues = validateDefinitionForStore(definitionJson);
  if (issues.length > 0) {
    const unsupported = issues.some((i) => i.code === 'STEP_TYPE_UNSUPPORTED' || i.code === 'STEP_FIELD_FORBIDDEN');
    throw new ApiError(
      unsupported ? 'COMPILER_UNSUPPORTED_STEP' : 'VALIDATION_ERROR',
      `Invalid test definition: ${issues.map((i) => i.message).join('; ')}`,
      unsupported ? 422 : 400,
      { issues },
    );
  }
}

// ---------------------------------------------------------------------------
// Run-terminal proposal creation (called by the runs wiring, see header)
// ---------------------------------------------------------------------------

export interface HealAttemptInput {
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
 * Persist one `pending` proposal per healed step that has a verified winner.
 * Dedupes on (testId, stepId, toLocator) while a `pending` proposal for the
 * same triple exists — re-runs of the same broken test must not spam the
 * review queue. Attempts without `succeededWith` (nothing matched uniquely)
 * are skipped: there is nothing reviewable to propose.
 */
export async function createHealingProposalsFromEvidence(opts: {
  testId: string;
  projectId: string;
  runId: string;
  attempts: HealAttemptInput[];
  createdBy?: string;
}): Promise<{ created: number; skipped: number; proposalIds: string[] }> {
  const parsed = z.array(healAttemptInput).safeParse(opts.attempts);
  if (!parsed.success) {
    throw new ApiError('VALIDATION_ERROR', 'Invalid healing evidence payload', 400, parsed.error.flatten());
  }
  let created = 0;
  let skipped = 0;
  const proposalIds: string[] = [];
  for (const attempt of parsed.data) {
    const toLocator = attempt.evidence?.succeededWith;
    if (!toLocator) {
      skipped += 1;
      continue;
    }
    assertLocatorShape(attempt.fromLocator, 'fromLocator');
    assertLocatorShape(toLocator, 'toLocator');
    const toKey = stableLocatorKey(toLocator);
    const pending = await db().healingProposal.findMany({
      where: { testId: opts.testId, stepId: attempt.stepId, status: 'pending' },
    });
    if (pending.some((p) => stableLocatorKey(JSON.parse(p.toLocator)) === toKey)) {
      skipped += 1;
      continue;
    }
    const row = await db().healingProposal.create({
      data: {
        projectId: opts.projectId,
        testId: opts.testId,
        stepId: attempt.stepId,
        runId: opts.runId,
        fromLocator: JSON.stringify(attempt.fromLocator),
        toLocator: JSON.stringify(toLocator),
        evidence: JSON.stringify({
          tried: attempt.evidence?.tried ?? [],
          matchCount: attempt.evidence?.matchCount ?? null,
          preview: attempt.evidence?.preview ?? null,
          verified: attempt.evidence?.verified ?? false,
          durationMs: attempt.evidence?.durationMs ?? null,
          reason: attempt.evidence?.reason ?? null,
        }),
        status: 'pending',
        ...(opts.createdBy !== undefined ? { createdBy: opts.createdBy } : {}),
      },
    });
    created += 1;
    proposalIds.push(row.id);
  }
  return { created, skipped, proposalIds };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function healingRoutes(app: FastifyInstance): Promise<void> {
  // List proposals for a test (default: pending review queue).
  app.get('/tests/:id/healing', { preHandler: requireAuth }, async (req) => {
    const { id } = parseOrThrowLocal(testIdParam, req.params);
    await requireProjectAccess(req);
    const test = await db().test.findUnique({ where: { id } });
    if (!test) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    const { status } = parseOrThrowLocal(healingListQuery, req.query);
    return db().healingProposal.findMany({
      where: { testId: id, ...(status === 'all' ? {} : { status }) },
      orderBy: { createdAt: 'desc' },
    });
  });

  // Approve: rewrite step primary <-> toLocator, demote old primary to the
  // head of alternatives, mint a new test version. The proposal becomes
  // `approved` with `decidedAt`; history records who approved via the version
  // changeMessage (audit trail without a separate table write).
  app.post('/healing/:pid/approve', { preHandler: requireAuth }, async (req) => {
    const { pid } = parseOrThrowLocal(proposalIdParam, req.params);
    const proposal = await db().healingProposal.findUnique({ where: { id: pid } });
    if (!proposal) throw new ApiError('NOT_FOUND', `Healing proposal ${pid} not found`, 404);
    if (proposal.status !== 'pending') {
      throw new ApiError('VALIDATION_ERROR', `Proposal ${pid} is already ${proposal.status}`, 400);
    }
    const test = await db().test.findUnique({
      where: { id: proposal.testId },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });
    if (!test || test.projectId !== proposal.projectId) {
      throw new ApiError('NOT_FOUND', `Test ${proposal.testId} not found`, 404);
    }
    await requireWriteAccessToProject(req, test.projectId);

    const fromLocator = JSON.parse(proposal.fromLocator) as unknown;
    const toLocator = JSON.parse(proposal.toLocator) as unknown;
    assertLocatorShape(fromLocator, 'fromLocator');
    assertLocatorShape(toLocator, 'toLocator');

    const def = JSON.parse(test.definitionJson) as { steps?: Array<Record<string, unknown>> };
    const steps = Array.isArray(def.steps) ? def.steps : [];
    const idx = steps.findIndex((s) => s['id'] === proposal.stepId);
    if (idx === -1) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `Step ${proposal.stepId} no longer exists in test ${test.id} — proposal is stale`,
        400,
      );
    }
    const step = steps[idx] as Record<string, unknown>;
    const target = (step['target'] ?? {}) as Record<string, unknown>;
    const currentPrimary = target['primary'] as unknown;
    if (stableLocatorKey(currentPrimary) !== stableLocatorKey(fromLocator)) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `Step ${proposal.stepId} primary changed since the proposal — re-run to get a fresh proposal`,
        400,
      );
    }
    const currentAlts = (Array.isArray(target['alternatives']) ? target['alternatives'] : []) as unknown[];
    const toKey = stableLocatorKey(toLocator);
    const fromKey = stableLocatorKey(fromLocator);
    const nextAlts = [
      fromLocator,
      ...currentAlts.filter((a) => {
        const k = stableLocatorKey(a);
        return k !== toKey && k !== fromKey;
      }),
    ];
    const nextSteps = steps.map((s, i) =>
      i === idx ? { ...s, target: { ...target, primary: toLocator, alternatives: nextAlts } } : s,
    );
    const nextDef = { ...def, steps: nextSteps };
    assertStorableDefinition(nextDef);
    const nextJson = JSON.stringify(nextDef);

    const updated = await db().test.update({ where: { id: test.id }, data: { definitionJson: nextJson } });
    const nextVersion = (test.versions[0]?.versionNumber ?? 0) + 1;
    const version = await db().testVersion.create({
      data: {
        testId: test.id,
        versionNumber: nextVersion,
        definitionJson: nextJson,
        createdBy: req.user!.id,
        changeMessage: `healing approve step ${proposal.stepId} by ${req.user!.id}: ${fromKey} -> ${toKey} (from run ${proposal.runId})`,
      },
    });
    const decided = await db().healingProposal.update({
      where: { id: pid },
      data: { status: 'approved', decidedAt: new Date() },
    });
    return { proposal: decided, test: updated, versionNumber: version.versionNumber };
  });

  // Reject: mark `rejected` with `decidedAt`. The definition is untouched.
  app.post('/healing/:pid/reject', { preHandler: requireAuth }, async (req) => {
    const { pid } = parseOrThrowLocal(proposalIdParam, req.params);
    const proposal = await db().healingProposal.findUnique({ where: { id: pid } });
    if (!proposal) throw new ApiError('NOT_FOUND', `Healing proposal ${pid} not found`, 404);
    if (proposal.status !== 'pending') {
      throw new ApiError('VALIDATION_ERROR', `Proposal ${pid} is already ${proposal.status}`, 400);
    }
    const test = await db().test.findUnique({ where: { id: proposal.testId }, select: { projectId: true } });
    if (!test || test.projectId !== proposal.projectId) {
      throw new ApiError('NOT_FOUND', `Test ${proposal.testId} not found`, 404);
    }
    await requireWriteAccessToProject(req, test.projectId);
    return db().healingProposal.update({
      where: { id: pid },
      data: { status: 'rejected', decidedAt: new Date() },
    });
  });
}
