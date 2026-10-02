import type { FastifyInstance } from 'fastify';
import {
  cancelRun,
  runTest,
  type RunRequest,
  type TestDefinition,
} from '@playwright-studio/runner';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { ApiError } from '../errors.js';
import { parseOrThrow, runCreate } from '../schemas.js';
import { checkAllowedHttpUrl, stripServerPaths } from '../security.js';
import { db } from '../db.js';
import { runEvent } from '../ws/events.js';
import {
  markQueuedEmittedByRoute,
  prismaRunStore,
  resolveRunVariables,
  runQueue,
  workerPublish,
} from '../runner-store.js';

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
    // Day 2 flow (runner-spec.md): enqueue to the in-process worker pool —
    // validate → resolve env → isolated workspace → compile → execute with
    // the custom reporter → stream WS → persist → cleanup. The route returns
    // 202 immediately; the worker owns the Playwright child pid from here.
    markQueuedEmittedByRoute(run.id);
    const definition = JSON.parse(test.definitionJson) as TestDefinition;
    const { projectVariables, environmentVariables } = await resolveRunVariables(
      test.projectId,
      body.environmentId,
    );
    const request: RunRequest = {
      runId: run.id,
      test: definition,
      projectId: test.projectId,
      environmentId: body.environmentId,
      browser: body.browser,
      headed: body.headed,
      projectVariables,
      environmentVariables,
      trigger: 'manual',
      triggeredBy: req.user!.id,
    };
    void runQueue
      .submit(run.id, async () => {
        // A cancel that landed while the job was still queued must win:
        // never resurrect a settled run by executing it afterwards.
        const current = await prismaRunStore.getRun(run.id);
        if (current?.status === 'cancelled') return { status: 'cancelled' as const, runId: run.id };
        return runTest(request, { store: prismaRunStore, publish: workerPublish });
      })
      .catch(async (err: unknown) => {
        // runTest settles internally; this is a last-resort guard against a
        // worker crash escaping the lifecycle (no unhandled rejections).
        const message = err instanceof Error ? err.message : String(err);
        await prismaRunStore.updateRun(run.id, {
          status: 'failed',
          finishedAt: Date.now(),
          errorSummary: stripServerPaths(`Worker crashed before settling: ${message}`),
        });
      });
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
    // Windows, kill(-pid) on POSIX — see runner process.ts) plus DB settle
    // (run -> cancelled, incomplete steps -> skipped) and publishes
    // `run.cancelled`. When the run never started executing (still queued),
    // fall through to the DB settle below with identical semantics.
    const workerHandled = await cancelRun(id, { store: prismaRunStore, publish: workerPublish });
    if (workerHandled) {
      const fresh = await db().run.findUnique({ where: { id }, include: { steps: true, artifacts: true } });
      if (!fresh) throw new ApiError('NOT_FOUND', `Run ${id} not found`, 404);
      if (fresh.errorSummary) fresh.errorSummary = stripServerPaths(fresh.errorSummary);
      for (const s of fresh.steps) {
        if (s.errorMessage) s.errorMessage = stripServerPaths(s.errorMessage);
      }
      return fresh;
    }
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
