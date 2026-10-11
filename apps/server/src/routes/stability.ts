import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { db } from '../db.js';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { requireProjectWrite } from '../rbac.js';
import { ApiError } from '../errors.js';
import { parseOrThrow, runCreate, stabilityRuns } from '../schemas.js';
import { scoreRubric } from '../rubric.js';
import { writeAudit } from './audit.js';
import { z } from 'zod';

/**
 * Stability gate (start-new confidence): run the SAME test N consecutive
 * times and stamp the definition stable only on N/N passes.
 *
 * POST /tests/:id/stability { environmentId, browser?, headed?, runs? (2-5, default 3),
 *                             datasetId?, rowIndex?, profileId?, async? }
 *   Drives the STANDARD POST /tests/:id/runs path via in-process inject —
 *   same validation, same queue, same healing proposals, same webhooks as N
 *   manual back-to-back runs. Sequential (await each terminal state), so one
 *   slow run cannot mask another.
 *   Sync (default): blocks until the verdict (may take minutes for slow tests).
 *   Async (`async: true`): returns 202 { gateId } immediately; poll
 *   GET /tests/:id/stability/gates/:gateId; cancel via
 *   DELETE /tests/:id/stability/gates/:gateId.
 * GET /tests/:id/stability → { stable, stableAt, stableRuns }
 *
 * Stamp semantics: `Test.stable` means "this exact definition passed N
 * consecutive runs" — PATCHing the definition clears it (see routes/tests.ts).
 * A later failed run does NOT clear it (environment flakes exist; re-run the
 * gate instead). No silent anything: the verdict lists every run id.
 */
const stabilityBody = runCreate
  .extend({ runs: stabilityRuns, async: z.boolean().optional() })
  .strict();

const TERMINAL = new Set(['passed', 'failed', 'cancelled']);
const POLL_MS = 2000;
const GATE_TIMEOUT_MS = 15 * 60 * 1000;

type GateStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';
interface GateRun { id: string; status: string }
interface GateState {
  gateId: string;
  testId: string;
  projectId: string;
  /** Definition snapshot at gate creation — the verdict must never certify a newer edit. */
  definitionJson: string;
  status: GateStatus;
  total: number;
  passed: number;
  runs: GateRun[];
  stable: boolean;
  stableAt: string | null;
  error: string | null;
  createdAt: number;
  cancelRequested: boolean;
}

/** In-flight + recently finished gates (same ephemeral-registry pattern as
 *  pending suite runs: the underlying Run rows are the durable record). */
const gates = new Map<string, GateState>();
const GATE_REGISTRY_CAP = 200;

function publicGate(g: GateState) {
  const { cancelRequested: _drop, createdAt: _drop2, projectId: _drop3, ...pub } = g;
  return pub;
}

function registerGate(g: GateState): void {
  gates.set(g.gateId, g);
  if (gates.size <= GATE_REGISTRY_CAP) return;
  // Evict oldest terminal gates first; running gates are never evicted.
  const terminal = [...gates.values()]
    .filter((x) => x.status === 'passed' || x.status === 'failed' || x.status === 'cancelled')
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const old of terminal) {
    gates.delete(old.gateId);
    if (gates.size <= GATE_REGISTRY_CAP) break;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function triggerStabilityRun(
  app: FastifyInstance,
  testId: string,
  forwardHeaders: Record<string, string>,
  triggerPayload: Record<string, unknown>,
  i: number,
  runsTotal: number,
): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: `/api/v1/tests/${testId}/runs`,
    headers: forwardHeaders,
    payload: triggerPayload,
  });
  if (created.statusCode !== 202) {
    // Standard path rejected (bad env/dataset/definition) — fail the
    // gate loudly with the first error, no partial stamp.
    const errBody = created.json() as { code?: string; message?: string };
    throw new ApiError(
      'VALIDATION_ERROR',
      `Stability run ${i + 1}/${runsTotal} rejected: ${errBody.code ?? created.statusCode} ${errBody.message ?? ''}`.trim(),
      400,
    );
  }
  return (created.json() as { id: string }).id;
}

async function awaitRunTerminal(app: FastifyInstance, runId: string, startedAt: number): Promise<string> {
  for (;;) {
    if (Date.now() - startedAt > GATE_TIMEOUT_MS) {
      throw new ApiError('VALIDATION_ERROR', `Stability gate timed out after 15 minutes (run ${runId} unsettled)`, 400);
    }
    await sleep(POLL_MS);
    const row = await db().run.findUnique({ where: { id: runId }, select: { status: true } });
    if (!row) throw new ApiError('NOT_FOUND', `Stability run ${runId} vanished`, 404);
    if (TERMINAL.has(row.status)) return row.status;
  }
}

async function applyVerdict(
  testId: string, projectId: string, userId: string, runs: GateRun[], expectedDefinitionJson: string,
): Promise<{ passed: number; stable: boolean; stableAt: Date | null; stale: boolean }> {
  // Mid-gate edit race: the definition may have changed while runs executed.
  // A stamp for the OLD runs must never certify the NEW definition.
  const current = await db().test.findUnique({ where: { id: testId }, select: { definitionJson: true } });
  if (!current) throw new ApiError('NOT_FOUND', `Test ${testId} was deleted during the stability gate`, 404);
  const stale = current.definitionJson !== expectedDefinitionJson;
  const passed = runs.filter((r) => r.status === 'passed').length;
  const stable = passed === runs.length && !stale;
  const updated = await db().test.update({
    where: { id: testId },
    data: stable
      ? { stable: true, stableAt: new Date(), stableRuns: runs.length }
      : { stable: false, stableAt: null, stableRuns: 0 },
  });
  await writeAudit({
    projectId, userId,
    action: 'stability.verdict', entityType: 'test', entityId: testId,
    details: { runs: runs.map((r) => r.id), passed, total: runs.length, stable, stale },
  });
  return { passed, stable, stableAt: updated.stableAt, stale };
}

/** Background driver for async gates: same sequential loop as the sync path. */
async function driveGate(
  app: FastifyInstance,
  gate: GateState,
  userId: string,
  forwardHeaders: Record<string, string>,
  triggerPayload: Record<string, unknown>,
): Promise<void> {
  const startedAt = Date.now();
  gate.status = 'running';
  try {
    for (let i = 0; i < gate.total; i += 1) {
      if (gate.cancelRequested) {
        gate.status = 'cancelled';
        return;
      }
      const runId = await triggerStabilityRun(app, gate.testId, forwardHeaders, triggerPayload, i, gate.total);
      gate.runs.push({ id: runId, status: 'queued' });
      const status = await awaitRunTerminal(app, runId, startedAt);
      gate.runs[gate.runs.length - 1]!.status = status;
      if (gate.cancelRequested) {
        // Cancel landed mid-run: stop this child too, then settle cancelled.
        await app.inject({
          method: 'POST', url: `/api/v1/runs/${runId}/cancel`,
          headers: forwardHeaders, payload: {},
        }).catch(() => undefined);
        const row = await db().run.findUnique({ where: { id: runId }, select: { status: true } }).catch(() => null);
        gate.runs[gate.runs.length - 1]!.status = row?.status ?? status;
        gate.status = 'cancelled';
        return;
      }
    }
    if (gate.cancelRequested) {
      gate.status = 'cancelled';
      return;
    }
    const verdict = await applyVerdict(gate.testId, gate.projectId, userId, gate.runs, gate.definitionJson);
    gate.passed = verdict.passed;
    gate.stable = verdict.stable;
    gate.stableAt = verdict.stableAt ? verdict.stableAt.toISOString() : null;
    if (verdict.stale) {
      gate.error = 'definition changed during the gate — verdict discarded, re-run the gate to certify the new definition';
    }
    gate.status = verdict.stable ? 'passed' : 'failed';
  } catch (e) {
    gate.status = gate.cancelRequested ? 'cancelled' : 'failed';
    gate.error = e instanceof ApiError ? `${e.code} ${e.message}` : e instanceof Error ? e.message : String(e);
  }
}

export async function stabilityRoutes(app: FastifyInstance): Promise<void> {
  app.post('/tests/:id/stability', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await requireProjectWrite(req);
    const body = parseOrThrow(stabilityBody, req.body);
    const test = await db().test.findUnique({ where: { id } });
    if (!test) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);

    // Forward the caller's credentials (Bearer or dev x-user-id) so the
    // standard path authorizes exactly as a direct call would.
    const forwardHeaders: Record<string, string> = { 'content-type': 'application/json' };
    if (typeof req.headers.authorization === 'string') forwardHeaders['authorization'] = req.headers.authorization;
    const devUser = req.headers['x-user-id'];
    if (typeof devUser === 'string') forwardHeaders['x-user-id'] = devUser;
    const triggerPayload = {
      environmentId: body.environmentId,
      browser: body.browser,
      headed: body.headed,
      ...(body.datasetId !== undefined ? { datasetId: body.datasetId } : {}),
      ...(body.rowIndex !== undefined ? { rowIndex: body.rowIndex } : {}),
      ...(body.profileId !== undefined ? { profileId: body.profileId } : {}),
    };

    const runsTotal = body.runs ?? 3;

    if (body.async === true) {
      const gate: GateState = {
        gateId: `gate_${nanoid(12)}`,
        testId: id,
        projectId: test.projectId,
        definitionJson: test.definitionJson,
        status: 'queued',
        total: runsTotal,
        passed: 0,
        runs: [],
        stable: false,
        stableAt: null,
        error: null,
        createdAt: Date.now(),
        cancelRequested: false,
      };
      registerGate(gate);
      await writeAudit({
        projectId: test.projectId, userId: req.user!.id,
        action: 'stability.gate_created', entityType: 'test', entityId: id,
        details: { gateId: gate.gateId, runs: runsTotal },
      });
      void driveGate(app, gate, req.user!.id, forwardHeaders, triggerPayload)
        .catch(() => { /* driveGate settles the gate itself; never reject */ });
      return reply.code(202).send({ ...publicGate(gate), poll: `/api/v1/tests/${id}/stability/gates/${gate.gateId}` });
    }

    const runs: Array<{ id: string; status: string }> = [];
    const startedAt = Date.now();
    for (let i = 0; i < runsTotal; i += 1) {
      const runId = await triggerStabilityRun(app, id, forwardHeaders, triggerPayload, i, runsTotal);
      // Sequential gate: wait for terminal state before the next run.
      const status = await awaitRunTerminal(app, runId, startedAt);
      runs.push({ id: runId, status });
    }

    const verdict = await applyVerdict(id, test.projectId, req.user!.id, runs, test.definitionJson);
    const stamped = await db().test.findUnique({ where: { id }, select: { stableAt: true } });
    return reply.code(200).send({
      testId: id,
      runs,
      passed: verdict.passed,
      total: runs.length,
      stable: verdict.stable,
      stableAt: stamped?.stableAt ?? null,
      ...(verdict.stale ? { note: 'definition changed during the gate — verdict discarded, re-run the gate to certify the new definition' } : {}),
    });
  });

  app.get('/tests/:id/stability/gates/:gateId', { preHandler: requireAuth }, async (req) => {
    const { id, gateId } = req.params as { id: string; gateId: string };
    await requireProjectAccess(req);
    const gate = gates.get(gateId);
    if (!gate || gate.testId !== id) {
      throw new ApiError('NOT_FOUND', `Stability gate ${gateId} not found`, 404);
    }
    return { ...publicGate(gate), poll: `/api/v1/tests/${id}/stability/gates/${gate.gateId}` };
  });

  app.delete('/tests/:id/stability/gates/:gateId', { preHandler: requireAuth }, async (req) => {
    const { id, gateId } = req.params as { id: string; gateId: string };
    await requireProjectWrite(req);
    const gate = gates.get(gateId);
    if (!gate || gate.testId !== id) {
      throw new ApiError('NOT_FOUND', `Stability gate ${gateId} not found`, 404);
    }
    if (gate.status === 'queued' || gate.status === 'running') {
      gate.cancelRequested = true;
      await writeAudit({
        projectId: gate.projectId, userId: req.user!.id,
        action: 'stability.gate_cancelled', entityType: 'test', entityId: id,
        details: { gateId: gate.gateId },
      });
      // Stop the currently executing child NOW (not just the flag — the
      // driver only re-checks between runs). Best-effort: the driver also
      // cancels on wake; the runCancel path is idempotent-ish (409 when
      // already terminal, swallowed here).
      const current = [...gate.runs].reverse().find((r) => !TERMINAL.has(r.status));
      if (current) {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (typeof req.headers.authorization === 'string') headers['authorization'] = req.headers.authorization;
        const devUser = req.headers['x-user-id'];
        if (typeof devUser === 'string') headers['x-user-id'] = devUser;
        await app.inject({
          method: 'POST', url: `/api/v1/runs/${current.id}/cancel`,
          headers, payload: {},
        }).catch(() => undefined);
      }
    }
    return { ...publicGate(gate), poll: `/api/v1/tests/${id}/stability/gates/${gate.gateId}` };
  });

  app.get('/tests/:id/stability', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    await requireProjectAccess(req);
    const test = await db().test.findUnique({ where: { id }, select: { stable: true, stableAt: true, stableRuns: true } });
    if (!test) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    return { testId: id, ...test };
  });

  // GET /tests/:id/rubric — deterministic recording-quality score (0-100).
  // Scores the STORED definition; nothing runs, nothing is persisted.
  app.get('/tests/:id/rubric', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    await requireProjectAccess(req);
    const test = await db().test.findUnique({ where: { id }, select: { definitionJson: true } });
    if (!test) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    let definition: unknown = null;
    try {
      definition = JSON.parse(test.definitionJson);
    } catch {
      // Corrupt JSON scores 0 with an explicit empty detail — never 500.
    }
    return { testId: id, ...scoreRubric(definition) };
  });
}
