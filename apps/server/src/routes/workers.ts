/**
 * P2 — distributed runners via a DB job-claim protocol (no extra infra).
 *
 * REGISTRATION CONTRACT (app.ts is frozen by task scope — maintainer wires):
 *   import { workerRoutes } from './routes/workers.js';
 *   await app.register(workerRoutes);   // paths are absolute (/api/v1/…), register at ROOT, no prefix
 *
 * PROTOCOL:
 * - POST /workers/register {name, capacity?} → upsert by name (online).
 * - POST /workers/:id/heartbeat → liveness + pull ONE oldest queued,
 *   unclaimed run (atomic claim). Returns {worker, claimedRun|null}.
 * - POST /workers/:id/complete {runId, status, …} → worker reports terminal
 *   state for a run it owns.
 * - POST /workers/:id/deregister → offline + release queued claims.
 * - POST /workers/sweep → mark heartbeat-stale workers offline + requeue.
 *   Heartbeat also best-effort sweeps (no cron infra needed).
 * - GET /workers → registry with live claimed-run counts.
 *
 * CLAIM ATOMICITY: `updateMany({where:{id, status:'queued', workerId:null}})`
 * — exactly one worker wins per run on shared Postgres. Capacity is honored
 * (active queued+running claims < capacity).
 *
 * HONEST LIMITS:
 * - True distribution needs a SHARED database (Postgres). The default
 *   SQLite file is process-host-local: remote workers pointing at different
 *   files will NOT see each other's queue (documented in docs + WorkersPage).
 * - There is NO `studio worker` CLI in this wave: a remote worker is any
 *   process that heartbeats, executes the claimed definition with Playwright,
 *   and posts /complete. The in-process runQueue stays the default executor.
 * - Claim flips the run queued→running immediately (remote start). If the
 *   worker dies between claim and /complete, the run stays `running` until a
 *   sweep/recovery marks it (same as P0 crash recovery semantics) — only
 *   still-`queued` claims are auto-released.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { ApiError } from '../errors.js';
import { parseOrThrow } from '../schemas.js';
import { db } from '../db.js';
import { stripServerPaths } from '../security.js';
import { requireGlobalWriter } from '../rbac.js';
import { writeAudit } from './audit.js';

// zod schemas colocated (route boundary shapes).
const registerBody = z.object({
  name: z.string().min(1).max(120),
  capacity: z.number().int().min(1).max(32).optional(),
});

const completeBody = z.object({
  runId: z.string().min(1),
  status: z.enum(['passed', 'failed', 'cancelled']),
  errorSummary: z.string().max(8000).optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

/** Heartbeat staleness threshold (runner-spec style constant, P2). */
export const STALE_WORKER_MS = 90_000;

export interface SweepReport {
  staleWorkers: string[];
  releasedRuns: string[];
}

/**
 * Mark heartbeat-stale `online` workers offline and release their
 * still-queued claims (status stays `queued`, workerId → null) so the local
 * queue or another worker can pick them up. Pure DB operation — shared by
 * the sweep route and the best-effort heartbeat sweep. Exported for tests.
 */
export async function requeueStaleWorkers(
  now: Date = new Date(),
  staleMs: number = STALE_WORKER_MS,
): Promise<SweepReport> {
  const cutoff = new Date(now.getTime() - staleMs);
  const stale = await db().worker.findMany({
    where: {
      status: 'online',
      OR: [{ lastHeartbeatAt: { lt: cutoff } }, { lastHeartbeatAt: null, updatedAt: { lt: cutoff } }],
    },
    select: { id: true, name: true },
  });
  const report: SweepReport = { staleWorkers: [], releasedRuns: [] };
  for (const w of stale) {
    await db().worker.update({ where: { id: w.id }, data: { status: 'offline' } });
    const claimed = await db().run.findMany({
      where: { workerId: w.id, status: 'queued' },
      select: { id: true, projectId: true },
    });
    if (claimed.length > 0) {
      await db().run.updateMany({
        where: { workerId: w.id, status: 'queued' },
        data: { workerId: null },
      });
    }
    report.staleWorkers.push(w.id);
    for (const r of claimed) {
      report.releasedRuns.push(r.id);
      void writeAudit({
        projectId: r.projectId,
        action: 'worker.stale-requeue',
        entityType: 'run',
        entityId: r.id,
        details: { workerId: w.id, workerName: w.name },
      });
    }
    void writeAudit({ action: 'worker.marked-offline', entityType: 'worker', entityId: w.id });
  }
  return report;
}

/**
 * Try to claim the oldest queued, unclaimed run for a worker. The
 * `updateMany` guard (status + workerId) is the atomic compare-and-set —
 * exactly one claimant wins under concurrency on shared Postgres.
 * Returns the claimed run (+ stored definition for remote execution) or null.
 */
export async function tryClaimQueuedRun(workerId: string): Promise<
  (Record<string, unknown> & { definitionJson: string }) | null
> {
  const candidates = await db().run.findMany({
    where: { status: 'queued', workerId: null },
    orderBy: { id: 'asc' },
    take: 5,
    include: { test: { select: { definitionJson: true, projectId: true } } },
  });
  for (const c of candidates) {
    const won = await db().run.updateMany({
      where: { id: c.id, status: 'queued', workerId: null },
      data: { workerId, status: 'running', startedAt: new Date() },
    });
    if (won.count === 1) {
      const fresh = await db().run.findUnique({ where: { id: c.id } });
      if (fresh?.errorSummary) fresh.errorSummary = stripServerPaths(fresh.errorSummary);
      void writeAudit({
        projectId: c.projectId,
        userId: null,
        action: 'worker.claim',
        entityType: 'run',
        entityId: c.id,
        details: { workerId },
      });
      return { ...(fresh as unknown as Record<string, unknown>), definitionJson: c.test.definitionJson };
    }
  }
  return null;
}

export async function workerRoutes(app: FastifyInstance): Promise<void> {
  // POST /workers/register
  app.post('/api/v1/workers/register', { preHandler: requireAuth }, async (req, reply) => {
    const actor = req.user!.id;
    await requireGlobalWriter(req);
    const body = parseOrThrow(registerBody, req.body);
    const worker = await db().worker.upsert({
      where: { name: body.name },
      update: { capacity: body.capacity ?? 2, status: 'online', lastHeartbeatAt: new Date() },
      create: { name: body.name, capacity: body.capacity ?? 2, status: 'online', lastHeartbeatAt: new Date() },
    });
    void writeAudit({
      userId: actor,
      action: 'worker.register',
      entityType: 'worker',
      entityId: worker.id,
      details: { name: worker.name, capacity: worker.capacity },
    });
    return reply.code(201).send(worker);
  });

  // GET /workers (+ live claimed counts; claimed run ids for the board).
  app.get('/api/v1/workers', { preHandler: requireAuth }, async () => {
    const workers = await db().worker.findMany({ orderBy: { updatedAt: 'desc' } });
    const claims = await db().run.findMany({
      where: { workerId: { not: null }, status: { in: ['queued', 'running'] } },
      select: { id: true, workerId: true, status: true, testId: true, projectId: true },
    });
    return workers.map((w) => ({
      ...w,
      activeClaims: claims.filter((c) => c.workerId === w.id).length,
      claimedRuns: claims.filter((c) => c.workerId === w.id),
    }));
  });

  // POST /workers/sweep (explicit stale requeue; heartbeat also sweeps).
  app.post('/api/v1/workers/sweep', { preHandler: requireAuth }, async (req) => {
    await requireGlobalWriter(req);
    return requeueStaleWorkers();
  });

  // POST /workers/:id/heartbeat → liveness + one claimed run (or null).
  app.post('/api/v1/workers/:id/heartbeat', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const worker = await db().worker.findUnique({ where: { id } });
    if (!worker) throw new ApiError('NOT_FOUND', `Worker ${id} not found`, 404);
    // Best-effort stale sweep on every heartbeat — no cron infra required.
    try {
      await requeueStaleWorkers();
    } catch {
      /* liveness must not fail because the sweep did */
    }
    // Revive explicitly-offline workers that heartbeat again (audited).
    const fresh = await db().worker.update({
      where: { id },
      data: { lastHeartbeatAt: new Date(), ...(worker.status === 'offline' ? { status: 'online' } : {}) },
    });
    if (worker.status === 'offline') {
      void writeAudit({ userId: req.user!.id, action: 'worker.revive', entityType: 'worker', entityId: id });
    }
    const active = await db().run.count({
      where: { workerId: id, status: { in: ['queued', 'running'] } },
    });
    const claimedRun = active < fresh.capacity ? await tryClaimQueuedRun(id) : null;
    return { worker: fresh, claimedRun };
  });

  // POST /workers/:id/complete — terminal report for a run the worker owns.
  app.post('/api/v1/workers/:id/complete', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const worker = await db().worker.findUnique({ where: { id } });
    if (!worker) throw new ApiError('NOT_FOUND', `Worker ${id} not found`, 404);
    const body = parseOrThrow(completeBody, req.body);
    const run = await db().run.findUnique({ where: { id: body.runId } });
    if (!run) throw new ApiError('NOT_FOUND', `Run ${body.runId} not found`, 404);
    if (run.workerId !== id) {
      throw new ApiError('INVALID_STATE', `Run ${body.runId} is not owned by worker ${id}`, 409);
    }
    if (run.status !== 'running') {
      throw new ApiError('INVALID_STATE', `Run ${body.runId} is ${run.status} (only running runs can complete)`, 409);
    }
    const finishedAt = new Date();
    const durationMs =
      body.durationMs ?? (run.startedAt ? Math.max(0, finishedAt.getTime() - run.startedAt.getTime()) : 0);
    const updated = await db().run.update({
      where: { id: body.runId },
      data: {
        status: body.status,
        finishedAt,
        durationMs,
        ...(body.errorSummary !== undefined
          ? { errorSummary: stripServerPaths(body.errorSummary).slice(0, 8000) }
          : {}),
      },
    });
    void writeAudit({
      userId: req.user!.id,
      projectId: run.projectId,
      action: 'worker.complete',
      entityType: 'run',
      entityId: run.id,
      details: { workerId: id, status: body.status },
    });
    return updated;
  });

  // POST /workers/:id/deregister — offline + release queued claims.
  app.post('/api/v1/workers/:id/deregister', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    await requireGlobalWriter(req);
    const worker = await db().worker.findUnique({ where: { id } });
    if (!worker) throw new ApiError('NOT_FOUND', `Worker ${id} not found`, 404);
    await db().worker.update({ where: { id }, data: { status: 'offline' } });
    const released = await db().run.updateMany({
      where: { workerId: id, status: 'queued' },
      data: { workerId: null },
    });
    void writeAudit({
      userId: req.user!.id,
      action: 'worker.deregister',
      entityType: 'worker',
      entityId: id,
      details: { releasedQueuedRuns: released.count },
    });
    const fresh = await db().worker.findUnique({ where: { id } });
    return { worker: fresh, releasedQueuedRuns: released.count };
  });
}
