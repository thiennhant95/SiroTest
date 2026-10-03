/**
 * P1 — Suites/tags + Suite parallelism/retries + JUnit export.
 *
 * - Suites CRUD: GET/POST /projects/:projectId/suites, GET/PATCH/DELETE /suites/:sid
 * - Members: GET/POST/DELETE /suites/:sid/tests (+ PUT full ordered replace for reorder;
 *   POST on an existing member updates its sortOrder)
 * - Tags: GET /projects/:projectId/tags (distinct tags from TestDefinition.tags);
 *   test filtering lives on GET /projects/:projectId/tests?tag=X (tests.ts)
 * - Suite runs: POST /suites/:sid/runs {environmentId, browser?, headed?, retries?, parallel?}
 *   → one suiteRunId + one Run per member (suiteId + suiteRunId set, trigger 'suite'),
 *   enqueued through the EXISTING runQueue (capacity 2 caps real parallelism).
 *   `parallel` is clamped 1..2: 2 = enqueue all at once, 1 = strict sequential.
 *   Retries (default 0, max 5) create NEW attempt rows (trigger 'suite-retry').
 * - Read: GET /suites/:sid/runs (grouped executions), GET /suite-runs/:suiteRunId,
 *   POST /suite-runs/:id/cancel, GET /suite-runs/:id/export?format=junit,
 *   GET /runs/:id/export?format=junit.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { runTest } from '@playwright-studio/runner';
import { cancelRun } from '@playwright-studio/runner';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { ApiError } from '../errors.js';
import { db } from '../db.js';
import { buildJunitXml, junitFilename, type JunitCase } from '../junit.js';
import {
  parseOrThrow,
  suiteCreate,
  suiteMemberAdd,
  suiteMembersReplace,
  suiteRunCreate,
  suiteUpdate,
} from '../schemas.js';
import {
  checkAllowedHttpUrl,
  decryptSecret,
  redactSecretsText,
  stripServerPaths,
} from '../security.js';
import {
  consumePendingSuiteRun,
  enqueueSuiteMember,
  getPendingSuiteRun,
  isSuiteRunCancelled,
  markSuiteRunCancelled,
  newSuiteRunId,
  pendingRunsForSuite,
  registerPendingSuiteRun,
} from '../suite-runs.js';
import { prismaRunStore, workerPublish } from '../runner-store.js';
import { broadcastRunEvent } from '../runner-store.js';

/**
 * Suite WS broadcasts go through the shared builder (runner-store.ts) so
 * runId/at/error-redaction stay consistent across single, suite and
 * scheduled runs. Kept as a thin local alias for call-site stability.
 */
function broadcast(type: Parameters<typeof broadcastRunEvent>[0], runId: string, extra: Record<string, unknown> = {}): void {
  broadcastRunEvent(type, runId, extra);
}

/**
 * Suite-level dataset check for one member definition. Returns a human
 * reason when the member cannot honor the suite's datasetId/rowIndex
 * selection, or null when it can. Never throws — the caller aggregates.
 */
function memberDatasetProblem(
  definitionJson: string,
  datasetId: string,
  rowIndex?: number,
): string | null {
  let datasets: Array<{ id?: unknown; rows?: unknown }> = [];
  try {
    const def = JSON.parse(definitionJson) as { datasets?: unknown };
    if (Array.isArray(def.datasets)) datasets = def.datasets as Array<{ id?: unknown; rows?: unknown }>;
  } catch {
    return 'definition is not valid JSON';
  }
  const found = datasets.find((d) => d.id === datasetId);
  if (!found) return `does not carry dataset '${datasetId}'`;
  if (rowIndex !== undefined) {
    const n = Array.isArray(found.rows) ? found.rows.length : 0;
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= n) {
      return `rowIndex ${rowIndex} out of range for dataset '${datasetId}' (${n} row(s))`;
    }
  }
  return null;
}

/**
 * Project membership for suite-scoped routes (params carry `sid`, not a
 * project id, so the shared requireProjectAccess cannot resolve the project).
 * Same contract as auth.ts: admins bypass, everyone else needs a member row.
 */
async function requireAccessToProject(req: FastifyRequest, projectId: string): Promise<void> {
  if (!req.user) throw new ApiError('UNAUTHORIZED', 'Missing credentials', 401);
  const userRow = await db().user.findUnique({ where: { id: req.user.id } });
  if (userRow?.role === 'admin') return;
  const member = await db().projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: req.user.id } },
  });
  if (!member) throw new ApiError('FORBIDDEN', `No access to project ${projectId}`, 403);
}

async function loadSuiteOrThrow(sid: string) {
  const suite = await db().testSuite.findUnique({
    where: { id: sid },
    include: {
      tests: {
        orderBy: { sortOrder: 'asc' },
        include: { test: { select: { id: true, name: true, projectId: true } } },
      },
    },
  });
  if (!suite) throw new ApiError('NOT_FOUND', `Suite ${sid} not found`, 404);
  return suite;
}

type SuiteRow = Awaited<ReturnType<typeof loadSuiteOrThrow>>;

/** Tags stored on a TestDefinition (test-model schemas.ts: tags?: string[]). */
function definitionTags(definitionJson: string): string[] {
  try {
    const def = JSON.parse(definitionJson) as { tags?: unknown };
    if (!Array.isArray(def.tags)) return [];
    return [...new Set(def.tags.filter((t): t is string => typeof t === 'string' && t.length > 0))];
  } catch {
    return [];
  }
}

/** Aggregate status over a set of child runs (failure dominates, then activity). */
export function aggregateSuiteStatus(statuses: string[]): string {
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('queued')) return 'queued';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('cancelled')) return 'cancelled';
  if (statuses.length > 0 && statuses.every((s) => s === 'passed')) return 'passed';
  return statuses.length === 0 ? 'queued' : 'running';
}

/** Plaintext secret values of a project (decrypted in-memory, never emitted). */
async function projectSecretValues(projectId: string): Promise<string[]> {
  const rows = await db().variable.findMany({ where: { projectId, isSecret: true } });
  const out: string[] = [];
  for (const r of rows) {
    try {
      const plain = decryptSecret(r.valueEncrypted);
      if (plain) out.push(plain);
    } catch {
      // Key missing / corrupt cell: skip — the runner already redacts stored
      // summaries, this is a second boundary, not the only one.
    }
  }
  return out;
}

function cleanError(text: string | null | undefined, secrets: string[]): string | null {
  if (!text) return null;
  return redactSecretsText(stripServerPaths(text), secrets);
}

export async function suiteRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------- suites CRUD ---
  app.get('/projects/:projectId/suites', { preHandler: requireAuth }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    return db().testSuite.findMany({
      where: { projectId },
      orderBy: { updatedAt: 'desc' },
      include: {
        tests: {
          orderBy: { sortOrder: 'asc' },
          include: { test: { select: { id: true, name: true } } },
        },
      },
    });
  });

  app.post('/projects/:projectId/suites', { preHandler: requireAuth }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    await requireProjectAccess(req);
    const project = await db().project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError('NOT_FOUND', `Project ${projectId} not found`, 404);
    const body = parseOrThrow(suiteCreate, req.body);
    const created = await db().testSuite.create({
      data: {
        projectId,
        name: body.name,
        description: body.description,
        createdBy: req.user!.id,
      },
    });
    return reply.code(201).send(created);
  });

  app.get('/suites/:sid', { preHandler: requireAuth }, async (req) => {
    const { sid } = req.params as { sid: string };
    const suite = await loadSuiteOrThrow(sid);
    await requireAccessToProject(req, suite.projectId);
    return suite;
  });

  app.patch('/suites/:sid', { preHandler: requireAuth }, async (req) => {
    const { sid } = req.params as { sid: string };
    const suite = await loadSuiteOrThrow(sid);
    await requireAccessToProject(req, suite.projectId);
    const body = parseOrThrow(suiteUpdate, req.body);
    return db().testSuite.update({ where: { id: sid }, data: { ...body } });
  });

  app.delete('/suites/:sid', { preHandler: requireAuth }, async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const suite = await loadSuiteOrThrow(sid);
    await requireAccessToProject(req, suite.projectId);
    // SuiteTest rows cascade; Run.suiteId is SetNull (history preserved).
    await db().testSuite.delete({ where: { id: sid } });
    return reply.code(204).send();
  });

  // --------------------------------------------------------------- members ---
  app.get('/suites/:sid/tests', { preHandler: requireAuth }, async (req) => {
    const { sid } = req.params as { sid: string };
    const suite = await loadSuiteOrThrow(sid);
    await requireAccessToProject(req, suite.projectId);
    return suite.tests;
  });

  app.post('/suites/:sid/tests', { preHandler: requireAuth }, async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const suite: SuiteRow = await loadSuiteOrThrow(sid);
    await requireAccessToProject(req, suite.projectId);
    const body = parseOrThrow(suiteMemberAdd, req.body);
    const test = await db().test.findUnique({ where: { id: body.testId } });
    if (!test) throw new ApiError('NOT_FOUND', `Test ${body.testId} not found`, 404);
    if (test.projectId !== suite.projectId) {
      throw new ApiError('VALIDATION_ERROR', 'Test belongs to a different project', 400);
    }
    const existing = await db().suiteTest.findUnique({
      where: { suiteId_testId: { suiteId: sid, testId: body.testId } },
    });
    if (existing) {
      // Re-adding is an order update (supports simple move-to-position UX).
      if (body.sortOrder !== undefined) {
        const updated = await db().suiteTest.update({
          where: { suiteId_testId: { suiteId: sid, testId: body.testId } },
          data: { sortOrder: body.sortOrder },
        });
        return reply.code(200).send(updated);
      }
      throw new ApiError('VALIDATION_ERROR', `Test ${body.testId} is already in suite ${sid}`, 409);
    }
    const maxOrder = suite.tests.length > 0 ? Math.max(...suite.tests.map((t) => t.sortOrder)) : -1;
    const created = await db().suiteTest.create({
      data: {
        suiteId: sid,
        testId: body.testId,
        sortOrder: body.sortOrder ?? maxOrder + 1,
      },
    });
    return reply.code(201).send(created);
  });

  // Full ordered replace — the canonical reorder operation.
  app.put('/suites/:sid/tests', { preHandler: requireAuth }, async (req) => {
    const { sid } = req.params as { sid: string };
    const suite: SuiteRow = await loadSuiteOrThrow(sid);
    await requireAccessToProject(req, suite.projectId);
    const body = parseOrThrow(suiteMembersReplace, req.body);
    if (new Set(body.testIds).size !== body.testIds.length) {
      throw new ApiError('VALIDATION_ERROR', 'testIds must be unique', 400);
    }
    const rows = await db().test.findMany({ where: { id: { in: body.testIds } } });
    if (rows.length !== body.testIds.length) {
      throw new ApiError('NOT_FOUND', 'One or more tests not found', 404);
    }
    for (const r of rows) {
      if (r.projectId !== suite.projectId) {
        throw new ApiError('VALIDATION_ERROR', `Test ${r.id} belongs to a different project`, 400);
      }
    }
    await db().suiteTest.deleteMany({ where: { suiteId: sid } });
    await db().suiteTest.createMany({
      data: body.testIds.map((testId, i) => ({ suiteId: sid, testId, sortOrder: i })),
    });
    return db().suiteTest.findMany({
      where: { suiteId: sid },
      orderBy: { sortOrder: 'asc' },
      include: { test: { select: { id: true, name: true } } },
    });
  });

  app.delete('/suites/:sid/tests/:testId', { preHandler: requireAuth }, async (req, reply) => {
    const { sid, testId } = req.params as { sid: string; testId: string };
    const suite = await loadSuiteOrThrow(sid);
    await requireAccessToProject(req, suite.projectId);
    try {
      await db().suiteTest.delete({ where: { suiteId_testId: { suiteId: sid, testId } } });
    } catch {
      throw new ApiError('NOT_FOUND', `Test ${testId} is not in suite ${sid}`, 404);
    }
    return reply.code(204).send();
  });

  // ------------------------------------------------------------------ tags ---
  app.get('/projects/:projectId/tags', { preHandler: requireAuth }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const tests = await db().test.findMany({ where: { projectId }, select: { definitionJson: true } });
    const counts = new Map<string, number>();
    for (const t of tests) {
      for (const tag of definitionTags(t.definitionJson)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  });

  // ------------------------------------------------------------ suite runs ---
  app.post('/suites/:sid/runs', { preHandler: requireAuth }, async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const suite: SuiteRow = await loadSuiteOrThrow(sid);
    await requireAccessToProject(req, suite.projectId);
    const body = parseOrThrow(suiteRunCreate, req.body);
    if (suite.tests.length === 0) {
      throw new ApiError('VALIDATION_ERROR', `Suite ${sid} has no tests`, 400);
    }
    const env = await db().environment.findUnique({ where: { id: body.environmentId } });
    if (!env || env.projectId !== suite.projectId) {
      throw new ApiError('VALIDATION_ERROR', 'environmentId does not belong to this project', 400);
    }
    // SSRF guard (same as single-test runs): env baseUrl wins, else project baseUrl.
    const project = await db().project.findUnique({ where: { id: suite.projectId } });
    const urlCheck = checkAllowedHttpUrl(env.baseUrl ?? project?.baseUrl ?? null);
    if (!urlCheck.ok) {
      throw new ApiError('VALIDATION_ERROR', `run target rejected: ${urlCheck.reason}`, 400);
    }
    const suiteRunId = newSuiteRunId();
    const fullTests = await db().test.findMany({ where: { id: { in: suite.tests.map((t) => t.testId) } } });
    const byId = new Map(fullTests.map((t) => [t.id, t]));
    const ordered = suite.tests.map((m) => byId.get(m.testId)).filter((t) => t !== undefined);
    if (ordered.length === 0) {
      throw new ApiError('VALIDATION_ERROR', `Suite ${sid} has no resolvable tests`, 400);
    }
    // Suite-level data selection: every member must carry the dataset (and
    // the row when given) — otherwise the trigger fails fast naming the
    // offending test instead of running the wrong data anywhere.
    if (body.datasetId === undefined && body.rowIndex !== undefined) {
      throw new ApiError('VALIDATION_ERROR', 'rowIndex requires datasetId', 400);
    }
    if (body.datasetId !== undefined) {
      for (const t of ordered) {
        const problem = memberDatasetProblem(t!.definitionJson, body.datasetId, body.rowIndex);
        if (problem) {
          throw new ApiError('VALIDATION_ERROR', `Test ${t!.id}: ${problem}`, 400);
        }
      }
    }

    const base = {
      projectId: suite.projectId,
      environmentId: body.environmentId,
      browser: body.browser ?? 'chromium',
      headed: body.headed ?? false,
      suiteId: sid,
      suiteRunId,
      triggeredBy: req.user!.id,
      retriesLeft: body.retries ?? 0,
      ...(body.profileId !== undefined ? { profileId: body.profileId } : {}),
      ...(body.healWithAlternatives === true ? { healWithAlternatives: true as const } : {}),
      ...(body.datasetId !== undefined ? { datasetId: body.datasetId } : {}),
      ...(body.rowIndex !== undefined ? { rowIndex: body.rowIndex } : {}),
    };

    if (body.parallel === 1) {
      // Strict sequential: each member (with its retries) settles before the
      // next is created. Fire-and-forget — the route returns 202 immediately.
      // Registered as pending so reads/cancel work before the first row exists.
      registerPendingSuiteRun(suiteRunId, {
        suiteId: sid,
        projectId: suite.projectId,
        testIds: ordered.map((t) => t!.id),
        retries: body.retries ?? 0,
        parallel: 1,
        createdAt: Date.now(),
      });
      // Strict sequential: each member (with its retries) settles before the
      // next is created. Fire-and-forget — the route returns 202 immediately.
      void (async () => {
        for (const t of ordered) {
          if (isSuiteRunCancelled(suiteRunId)) break;
          const started = await enqueueSuiteMember(runTest, {
            ...base,
            trigger: 'suite',
            testId: t!.id,
            definitionJson: t!.definitionJson,
          });
          await started.done;
        }
      })().catch(() => { /* crash guards already settle rows; never reject */ });
      return reply.code(202).send({
        suiteRunId,
        suiteId: sid,
        status: 'queued',
        parallel: 1,
        retries: body.retries ?? 0,
        testIds: ordered.map((t) => t!.id),
      });
    }

    // parallel = 2 (default): create every member row now, submit all at once;
    // the shared runQueue(2) caps real concurrency — no extra semaphore.
    const starters = await Promise.all(
      ordered.map((t) =>
        enqueueSuiteMember(runTest, {
          ...base,
          trigger: 'suite',
          testId: t!.id,
          definitionJson: t!.definitionJson,
        }),
      ),
    );
    void Promise.all(starters.map((s) => s.done)).catch(() => {});
    return reply.code(202).send({
      suiteRunId,
      suiteId: sid,
      status: 'queued',
      parallel: 2,
      retries: body.retries ?? 0,
      runs: starters.map((s, i) => ({ id: s.runId, testId: ordered[i]!.id, status: 'queued' })),
    });
  });

  app.get('/suites/:sid/runs', { preHandler: requireAuth }, async (req) => {
    const { sid } = req.params as { sid: string };
    const suite = await loadSuiteOrThrow(sid);
    await requireAccessToProject(req, suite.projectId);
    const rows = await db().run.findMany({ where: { suiteId: sid } });
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!r.suiteRunId) continue;
      const g = groups.get(r.suiteRunId) ?? [];
      g.push(r);
      groups.set(r.suiteRunId, g);
    }
    const executions = [...groups.entries()].map(([suiteRunId, members]) => {
      const statuses = members.map((m) => m.status);
      const counts = {
        total: members.length,
        passed: statuses.filter((s) => s === 'passed').length,
        failed: statuses.filter((s) => s === 'failed').length,
        running: statuses.filter((s) => s === 'running' || s === 'queued').length,
        cancelled: statuses.filter((s) => s === 'cancelled').length,
      };
      const activity = members
        .map((m) => Math.max(m.finishedAt?.getTime() ?? 0, m.startedAt?.getTime() ?? 0))
        .sort((a, b) => b - a)[0] ?? 0;
      return { suiteRunId, suiteId: sid, status: aggregateSuiteStatus(statuses), counts, lastActivityAt: activity };
    });
    executions.sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.suiteRunId.localeCompare(a.suiteRunId));
    // Accepted-but-not-yet-started sequential executions (no rows yet).
    for (const p of pendingRunsForSuite(sid)) {
      if (groups.has(p.suiteRunId)) continue;
      executions.unshift({
        suiteRunId: p.suiteRunId,
        suiteId: sid,
        status: isSuiteRunCancelled(p.suiteRunId) ? 'cancelled' : 'queued',
        counts: { total: p.testIds.length, passed: 0, failed: 0, running: p.testIds.length, cancelled: 0 },
        lastActivityAt: p.createdAt,
      });
    }
    return executions;
  });

  app.get('/suite-runs/:suiteRunId', { preHandler: requireAuth }, async (req) => {
    const { suiteRunId } = req.params as { suiteRunId: string };
    const rows = await db().run.findMany({
      where: { suiteRunId },
      include: { test: { select: { id: true, name: true } } },
    });
    if (rows.length === 0) {
      // Sequential execution accepted but no row created yet: answer queued
      // instead of 404 (the chain registers itself as pending at POST time).
      const pending = getPendingSuiteRun(suiteRunId);
      if (!pending) throw new ApiError('NOT_FOUND', `Suite run ${suiteRunId} not found`, 404);
      await requireAccessToProject(req, pending.projectId);
      const suite = await db().testSuite.findUnique({ where: { id: pending.suiteId } });
      return {
        suiteRunId,
        suite,
        status: isSuiteRunCancelled(suiteRunId) ? 'cancelled' : 'queued',
        tests: [],
      };
    }
    consumePendingSuiteRun(suiteRunId);
    await requireAccessToProject(req, rows[0]!.projectId);
    const suite = rows[0]!.suiteId
      ? await db().testSuite.findUnique({ where: { id: rows[0]!.suiteId } })
      : null;
    // Per-test rollup: attempts in creation order (cuid ≈ time-ordered),
    // final status = last attempt. Retry count = attempts - 1.
    const byTest = new Map<string, typeof rows>();
    for (const r of [...rows].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const g = byTest.get(r.testId) ?? [];
      g.push(r);
      byTest.set(r.testId, g);
    }
    const tests = [...byTest.entries()].map(([testId, attempts]) => ({
      testId,
      testName: attempts[0]!.test.name,
      attempts: attempts.map((a, i) => ({
        runId: a.id,
        attempt: i + 1,
        status: a.status,
        browser: a.browser,
        trigger: a.trigger,
        errorSummary: a.errorSummary ? stripServerPaths(a.errorSummary) : null,
        durationMs: a.durationMs,
        startedAt: a.startedAt,
        finishedAt: a.finishedAt,
      })),
      retryCount: attempts.length - 1,
      finalStatus: attempts[attempts.length - 1]!.status,
    }));
    return {
      suiteRunId,
      suite,
      status: aggregateSuiteStatus(rows.map((r) => r.status)),
      tests,
    };
  });

  app.post('/suite-runs/:suiteRunId/cancel', { preHandler: requireAuth }, async (req) => {
    const { suiteRunId } = req.params as { suiteRunId: string };
    const rows = await db().run.findMany({ where: { suiteRunId }, include: { steps: true } });
    if (rows.length === 0) {
      // Cancel before the first row exists (sequential chain): stop the chain
      // and consume the pending registration.
      const pending = getPendingSuiteRun(suiteRunId);
      if (!pending) throw new ApiError('NOT_FOUND', `Suite run ${suiteRunId} not found`, 404);
      await requireAccessToProject(req, pending.projectId);
      markSuiteRunCancelled(suiteRunId);
      consumePendingSuiteRun(suiteRunId);
      return { suiteRunId, cancelled: [], alreadyTerminal: [] };
    }
    await requireAccessToProject(req, rows[0]!.projectId);
    // Stop queued retries first so no new attempt rows appear afterwards.
    markSuiteRunCancelled(suiteRunId);
    const cancelled: string[] = [];
    const alreadyTerminal: string[] = [];
    for (const run of rows) {
      if (run.status !== 'queued' && run.status !== 'running') {
        alreadyTerminal.push(run.id);
        continue;
      }
      // Same two-path cancel as single runs (runs.ts): the worker that owns
      // the Playwright child pid does the real tree-kill; queued-but-idle
      // runs fall through to the identical DB settle below.
      const workerHandled = await cancelRun(run.id, { store: prismaRunStore, publish: workerPublish });
      if (!workerHandled) {
        const now = new Date();
        for (const s of run.steps) {
          if (s.status === 'pending' || s.status === 'running') {
            await db().runStep.update({
              where: { id: s.id },
              data: { status: 'skipped', finishedAt: now, errorMessage: s.errorMessage ?? 'Cancelled by user' },
            });
          }
        }
        await db().run.update({ where: { id: run.id }, data: { status: 'cancelled', finishedAt: now } });
        broadcast('run.cancelled', run.id, { suiteRunId });
      }
      cancelled.push(run.id);
    }
    return { suiteRunId, cancelled, alreadyTerminal };
  });

  // ------------------------------------------------------------ JUnit XML ---
  app.get('/suite-runs/:suiteRunId/export', { preHandler: requireAuth }, async (req, reply) => {
    const { suiteRunId } = req.params as { suiteRunId: string };
    const { format } = req.query as { format?: string };
    if (format !== undefined && format !== 'junit') {
      throw new ApiError('VALIDATION_ERROR', 'Only format=junit is supported', 400);
    }
    const rows = await db().run.findMany({
      where: { suiteRunId },
      include: { test: { select: { id: true, name: true } } },
    });
    if (rows.length === 0) throw new ApiError('NOT_FOUND', `Suite run ${suiteRunId} not found`, 404);
    await requireAccessToProject(req, rows[0]!.projectId);
    const suiteName = rows[0]!.suiteId
      ? (await db().testSuite.findUnique({ where: { id: rows[0]!.suiteId } }))?.name ?? suiteRunId
      : suiteRunId;
    const secrets = await projectSecretValues(rows[0]!.projectId);
    // One testcase per test (FINAL attempt); retries stay visible via the
    // "[attempt N]" suffix and the retry counts in GET /suite-runs/:id.
    const byTest = new Map<string, typeof rows>();
    for (const r of rows) {
      const g = byTest.get(r.testId) ?? [];
      g.push(r);
      byTest.set(r.testId, g);
    }
    const cases: JunitCase[] = [...byTest.values()].map((attempts) => {
      const orderedAttempts = [...attempts].sort((a, b) => (a.id < b.id ? -1 : 1));
      const last = orderedAttempts[orderedAttempts.length - 1]!;
      return {
        name: last.test.name,
        classname: suiteName,
        status: last.status,
        durationMs: last.durationMs,
        message: cleanError(last.errorSummary, secrets),
        body: cleanError(last.errorSummary, secrets),
        attempt: orderedAttempts.length,
      };
    });
    const xml = buildJunitXml(suiteName, cases, { secrets });
    return reply
      .header('content-type', 'application/xml')
      .header('content-disposition', `attachment; filename="${junitFilename(suiteRunId)}"`)
      .send(xml);
  });

  app.get('/runs/:id/export', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { format } = req.query as { format?: string };
    if (format !== undefined && format !== 'junit') {
      throw new ApiError('VALIDATION_ERROR', 'Only format=junit is supported', 400);
    }
    const run = await db().run.findUnique({
      where: { id },
      include: { test: { select: { id: true, name: true } }, project: { select: { name: true } } },
    });
    if (!run) throw new ApiError('NOT_FOUND', `Run ${id} not found`, 404);
    await requireAccessToProject(req, run.projectId);
    const secrets = await projectSecretValues(run.projectId);
    const xml = buildJunitXml(run.project.name, [{
      name: run.test.name,
      classname: run.project.name,
      status: run.status,
      durationMs: run.durationMs,
      message: cleanError(run.errorSummary, secrets),
      body: cleanError(run.errorSummary, secrets),
    }], { secrets });
    return reply
      .header('content-type', 'application/xml')
      .header('content-disposition', `attachment; filename="${junitFilename(id)}"`)
      .send(xml);
  });
}
