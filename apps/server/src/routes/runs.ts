import type { FastifyInstance } from 'fastify';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { ApiError } from '../errors.js';
import { parseOrThrow, runCreate } from '../schemas.js';
import { checkAllowedHttpUrl, stripServerPaths } from '../security.js';
import { db } from '../db.js';
import { runEvent } from '../ws/events.js';

function broadcast(type: Parameters<typeof runEvent>[1], runId: string, extra: Record<string, unknown> = {}): void {
  const send = (globalThis as { __vvWsBroadcast?: (e: string, p: unknown) => void }).__vvWsBroadcast;
  send?.(type, { runId, at: Date.now(), ...extra });
}

export async function runRoutes(app: FastifyInstance): Promise<void> {
  // POST /tests/:id/runs  { environmentId, browser, headed }
  app.post('/tests/:id/runs', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await requireProjectAccess(req);
    const body = parseOrThrow(runCreate, req.body);
    const test = await db().test.findUnique({ where: { id } });
    if (!test) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    const env = await db().environment.findUnique({ where: { id: body.environmentId } });
    if (!env || env.projectId !== test.projectId) {
      throw new ApiError('VALIDATION_ERROR', 'environmentId does not belong to this project', 400);
    }
    // SSRF guard: the run target (env baseUrl wins, else project/test baseUrl)
    // must be a public http(s) URL before a privileged browser is launched.
    const project = await db().project.findUnique({ where: { id: test.projectId } });
    const target = env.baseUrl ?? project?.baseUrl ?? null;
    const urlCheck = checkAllowedHttpUrl(target);
    if (!urlCheck.ok) {
      throw new ApiError('VALIDATION_ERROR', `run target rejected: ${urlCheck.reason}`, 400);
    }
    const run = await db().run.create({
      data: {
        projectId: test.projectId, testId: id,
        environmentId: body.environmentId, browser: body.browser,
        status: 'queued', trigger: 'manual',
      },
    });
    broadcast('run.queued', run.id, { testId: id });
    // TODO: enqueue to runner worker (Day 2 flow: compile -> isolated workspace -> execute)
    return reply.code(202).send(run);
  });

  app.get('/tests/:id/runs', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return db().run.findMany({ where: { testId: id }, orderBy: { startedAt: 'desc' } });
  });

  app.get('/runs/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const run = await db().run.findUnique({ where: { id }, include: { steps: true, artifacts: true } });
    if (!run) throw new ApiError('NOT_FOUND', `Run ${id} not found`, 404);
    // Defense-in-depth: never expose absolute server paths to browser clients
    // (artifacts already use storage-relative `runs/<run-id>/…` paths).
    if (run.errorSummary) run.errorSummary = stripServerPaths(run.errorSummary);
    for (const s of run.steps) {
      if (s.errorMessage) s.errorMessage = stripServerPaths(s.errorMessage);
    }
    return run;
  });

  app.post('/runs/:id/cancel', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const run = await db().run.findUnique({ where: { id }, include: { steps: true } });
    if (!run) throw new ApiError('NOT_FOUND', `Run ${id} not found`, 404);
    if (run.status !== 'queued' && run.status !== 'running') {
      throw new ApiError('RUN_NOT_CANCELLABLE', `Run ${id} is ${run.status} and cannot be cancelled`, 409);
    }
    // Recovery (runner-spec.md): the worker that owns the Playwright child
    // pid performs the real tree-kill (taskkill /PID <pid> /T /F on
    // Windows, kill(-pid) on POSIX — see runner process.ts). This route
    // always settles the DB — the source of truth the WS client refetches
    // after `run.cancelled` — with the same semantics: run -> cancelled,
    // incomplete steps -> skipped (step enum has no 'cancelled').
    const now = new Date();
    for (const s of run.steps) {
      if (s.status === 'pending' || s.status === 'running') {
        await db().runStep.update({
          where: { id: s.id },
          data: { status: 'skipped', finishedAt: now, errorMessage: s.errorMessage ?? 'Cancelled by user' },
        });
      }
    }
    const updated = await db().run.update({
      where: { id }, data: { status: 'cancelled', finishedAt: now },
    });
    broadcast('run.cancelled', id, {});
    return updated;
  });
}
