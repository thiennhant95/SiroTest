import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { requireProjectWrite } from '../rbac.js';
import { ApiError } from '../errors.js';
import { parseOrThrow, runCreate, stabilityRuns } from '../schemas.js';
import { scoreRubric } from '../rubric.js';
import { writeAudit } from './audit.js';

/**
 * Stability gate (start-new confidence): run the SAME test N consecutive
 * times and stamp the definition stable only on N/N passes.
 *
 * POST /tests/:id/stability { environmentId, browser?, headed?, runs? (2-5, default 3),
 *                             datasetId?, rowIndex?, profileId? }
 *   Drives the STANDARD POST /tests/:id/runs path via in-process inject —
 *   same validation, same queue, same healing proposals, same webhooks as N
 *   manual back-to-back runs. Sequential (await each terminal state), so one
 *   slow run cannot mask another. Sync: may take minutes for slow tests.
 * GET /tests/:id/stability → { stable, stableAt, stableRuns }
 *
 * Stamp semantics: `Test.stable` means "this exact definition passed N
 * consecutive runs" — PATCHing the definition clears it (see routes/tests.ts).
 * A later failed run does NOT clear it (environment flakes exist; re-run the
 * gate instead). No silent anything: the verdict lists every run id.
 */
const stabilityBody = runCreate
  .extend({ runs: stabilityRuns })
  .strict();

const TERMINAL = new Set(['passed', 'failed', 'cancelled']);
const POLL_MS = 2000;
const GATE_TIMEOUT_MS = 15 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
    const runs: Array<{ id: string; status: string }> = [];
    const startedAt = Date.now();
    for (let i = 0; i < runsTotal; i += 1) {
      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/tests/${id}/runs`,
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
      const runId = (created.json() as { id: string }).id;
      // Sequential gate: wait for terminal state before the next run.
      let status = 'queued';
      for (;;) {
        if (Date.now() - startedAt > GATE_TIMEOUT_MS) {
          throw new ApiError('VALIDATION_ERROR', `Stability gate timed out after 15 minutes (run ${runId} unsettled)`, 400);
        }
        await sleep(POLL_MS);
        const row = await db().run.findUnique({ where: { id: runId }, select: { status: true } });
        if (!row) throw new ApiError('NOT_FOUND', `Stability run ${runId} vanished`, 404);
        status = row.status;
        if (TERMINAL.has(status)) break;
      }
      runs.push({ id: runId, status });
    }

    const passed = runs.filter((r) => r.status === 'passed').length;
    const stable = passed === runs.length;
    const updated = await db().test.update({
      where: { id },
      data: stable
        ? { stable: true, stableAt: new Date(), stableRuns: runs.length }
        : { stable: false, stableAt: null, stableRuns: 0 },
    });
    void writeAudit({
      projectId: test.projectId, userId: req.user!.id,
      action: 'stability.verdict', entityType: 'test', entityId: id,
      details: { runs: runs.map((r) => r.id), passed, total: runs.length, stable },
    });
    return reply.code(200).send({
      testId: id,
      runs,
      passed,
      total: runs.length,
      stable,
      stableAt: updated.stableAt,
    });
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
