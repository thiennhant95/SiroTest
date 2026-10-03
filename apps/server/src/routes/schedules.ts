import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db.js';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { ApiError } from '../errors.js';
import { parseOrThrow, scheduleCreate, scheduleUpdate } from '../schemas.js';

/**
 * P1 wave-2 — scheduled suite/test runs (CRUD only).
 *
 * - CRUD: GET/POST /projects/:projectId/schedules, GET/PATCH/DELETE
 *   /schedules/:sid, plus GET /schedules/:sid/runs (history: runs with
 *   trigger 'schedule' for this schedule's target — the Schedule↔Run link
 *   is by target because the P0 Run table carries no scheduleId column).
 * - Body: { suiteId? | testId? (exactly one), environmentId, cron,
 *   enabled?, retries? }. No ticker runs here: the agent CLI evaluates cron
 *   and triggers runs; the server only stores the intent (lastRunAt/nextRunAt
 *   are the ticker's fields, never accepted from clients).
 * - cron is a 5-field `minute hour dom month dow` expression; each field
 *   supports wildcards, step values, `a-b` ranges and `a,b,…` lists within
 *   the minute 0-59 / hour 0-23 / dom 1-31 / month 1-12 / dow 0-7 ranges.
 *   Out-of-range or malformed expressions fail with CRON_INVALID (400).
 * - An identical ENABLED schedule (same target + same cron) is rejected
 *   with SCHEDULE_CONFLICT (409) instead of silently doubling executions.
 */

const CRON_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (7 = Sunday, like classic cron)
];

function checkCronField(field: string, min: number, max: number): boolean {
  // `*` or `*/step`
  if (field === '*') return true;
  const stepSplit = field.split('/');
  if (stepSplit.length > 2) return false;
  const base = stepSplit[0]!;
  if (stepSplit.length === 2) {
    if (!/^\d+$/.test(stepSplit[1]!) || Number(stepSplit[1]) < 1) return false;
    if (base !== '*' && !base.includes('-')) return false;
  }
  if (base === '*') return true;
  // comma list of `n` or `a-b`
  return base.split(',').every((part) => {
    if (/^\d+$/.test(part)) {
      const n = Number(part);
      return n >= min && n <= max;
    }
    const m = /^(\d+)-(\d+)$/.exec(part);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a <= b && a >= min && b <= max;
  });
}

/** Null when valid; a human reason when not (route maps to CRON_INVALID). */
export function cronIssue(cron: string): string | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    return `cron must have exactly 5 fields (minute hour dom month dow), got ${fields.length}`;
  }
  const names = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'];
  for (let i = 0; i < 5; i++) {
    const [min, max] = CRON_RANGES[i]!;
    if (!checkCronField(fields[i]!, min, max)) {
      return `cron field ${i + 1} (${names[i]!}, "${fields[i]}") is out of range ${min}-${max} or malformed`;
    }
  }
  return null;
}

export function assertValidCron(cron: string): void {
  const issue = cronIssue(cron);
  if (issue) throw new ApiError('CRON_INVALID', `Invalid cron "${cron}": ${issue}`, 400);
}

async function requireAccessToProject(req: FastifyRequest, projectId: string): Promise<void> {
  if (!req.user) throw new ApiError('UNAUTHORIZED', 'Missing credentials', 401);
  const userRow = await db().user.findUnique({ where: { id: req.user.id } });
  if (userRow?.role === 'admin') return;
  const member = await db().projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: req.user.id } },
  });
  if (!member) throw new ApiError('FORBIDDEN', `No access to project ${projectId}`, 403);
}

async function loadScheduleOrThrow(sid: string) {
  const row = await db().schedule.findUnique({ where: { id: sid } });
  if (!row) throw new ApiError('NOT_FOUND', `Schedule ${sid} not found`, 404);
  return row;
}

/** Exactly-one target rule + same-project checks; returns normalized targets. */
async function checkTarget(
  projectId: string,
  suiteId: string | null | undefined,
  testId: string | null | undefined,
): Promise<{ suiteId: string | null; testId: string | null }> {
  if ((suiteId ? 1 : 0) + (testId ? 1 : 0) !== 1) {
    throw new ApiError('VALIDATION_ERROR', 'Exactly one of suiteId / testId is required', 400);
  }
  if (suiteId) {
    const suite = await db().testSuite.findUnique({ where: { id: suiteId } });
    if (!suite) throw new ApiError('NOT_FOUND', `Suite ${suiteId} not found`, 404);
    if (suite.projectId !== projectId) {
      throw new ApiError('VALIDATION_ERROR', 'Suite belongs to a different project', 400);
    }
    return { suiteId, testId: null };
  }
  const test = await db().test.findUnique({ where: { id: testId! } });
  if (!test) throw new ApiError('NOT_FOUND', `Test ${testId} not found`, 404);
  if (test.projectId !== projectId) {
    throw new ApiError('VALIDATION_ERROR', 'Test belongs to a different project', 400);
  }
  return { suiteId: null, testId: testId! };
}

async function checkEnv(projectId: string, environmentId: string): Promise<void> {
  const env = await db().environment.findUnique({ where: { id: environmentId } });
  if (!env || env.projectId !== projectId) {
    throw new ApiError('VALIDATION_ERROR', 'environmentId does not belong to this project', 400);
  }
}

async function assertNoDuplicate(
  projectId: string,
  suiteId: string | null,
  testId: string | null,
  cron: string,
  ignoreId?: string,
): Promise<void> {
  const dup = await db().schedule.findFirst({
    where: {
      projectId,
      suiteId,
      testId,
      cron,
      enabled: true,
      ...(ignoreId ? { NOT: { id: ignoreId } } : {}),
    },
  });
  if (dup) {
    throw new ApiError(
      'SCHEDULE_CONFLICT',
      `An enabled schedule for the same target with cron "${cron}" already exists (${dup.id})`,
      409,
      { scheduleId: dup.id },
    );
  }
}

export async function scheduleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects/:projectId/schedules', { preHandler: requireAuth }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    await requireProjectAccess(req);
    return db().schedule.findMany({ where: { projectId }, orderBy: { updatedAt: 'desc' } });
  });

  app.post('/projects/:projectId/schedules', { preHandler: requireAuth }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    await requireProjectAccess(req);
    const project = await db().project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError('NOT_FOUND', `Project ${projectId} not found`, 404);
    const body = parseOrThrow(scheduleCreate, req.body);
    const target = await checkTarget(projectId, body.suiteId, body.testId);
    await checkEnv(projectId, body.environmentId);
    assertValidCron(body.cron);
    if (body.enabled ?? true) {
      await assertNoDuplicate(projectId, target.suiteId, target.testId, body.cron);
    }
    const created = await db().schedule.create({
      data: {
        projectId,
        suiteId: target.suiteId,
        testId: target.testId,
        environmentId: body.environmentId,
        cron: body.cron,
        enabled: body.enabled ?? true,
        retries: body.retries ?? 0,
        createdBy: req.user!.id,
      },
    });
    return reply.code(201).send(created);
  });

  app.get('/schedules/:sid', { preHandler: requireAuth }, async (req) => {
    const { sid } = req.params as { sid: string };
    const row = await loadScheduleOrThrow(sid);
    await requireAccessToProject(req, row.projectId);
    return row;
  });

  app.patch('/schedules/:sid', { preHandler: requireAuth }, async (req) => {
    const { sid } = req.params as { sid: string };
    const row = await loadScheduleOrThrow(sid);
    await requireAccessToProject(req, row.projectId);
    const body = parseOrThrow(scheduleUpdate, req.body);
    // Target merge: an explicit suiteId/testId re-targets and clears the
    // other side (exactly-one rule); otherwise the existing target is kept.
    // Explicit null clears one side (leaving neither → explicit 400 below).
    let target = { suiteId: row.suiteId, testId: row.testId };
    if (body.suiteId !== undefined || body.testId !== undefined) {
      const nextSuite = body.suiteId !== undefined
        ? body.suiteId
        : body.testId !== undefined ? null : row.suiteId;
      const nextTest = body.testId !== undefined
        ? body.testId
        : body.suiteId !== undefined ? null : row.testId;
      target = await checkTarget(row.projectId, nextSuite, nextTest);
    }
    if (body.environmentId !== undefined) await checkEnv(row.projectId, body.environmentId);
    const nextCron = body.cron ?? row.cron;
    if (body.cron !== undefined) assertValidCron(nextCron);
    const nextEnabled = body.enabled ?? row.enabled;
    if (nextEnabled) {
      await assertNoDuplicate(row.projectId, target.suiteId, target.testId, nextCron, sid);
    }
    return db().schedule.update({
      where: { id: sid },
      data: {
        suiteId: target.suiteId,
        testId: target.testId,
        ...(body.environmentId !== undefined ? { environmentId: body.environmentId } : {}),
        ...(body.cron !== undefined ? { cron: body.cron } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.retries !== undefined ? { retries: body.retries } : {}),
      },
    });
  });

  app.delete('/schedules/:sid', { preHandler: requireAuth }, async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const row = await loadScheduleOrThrow(sid);
    await requireAccessToProject(req, row.projectId);
    // Run history is preserved (Run rows carry no scheduleId FK).
    await db().schedule.delete({ where: { id: sid } });
    return reply.code(204).send();
  });

  // History: runs triggered by the scheduler for this schedule's target.
  app.get('/schedules/:sid/runs', { preHandler: requireAuth }, async (req) => {
    const { sid } = req.params as { sid: string };
    const row = await loadScheduleOrThrow(sid);
    await requireAccessToProject(req, row.projectId);
    return db().run.findMany({
      where: {
        projectId: row.projectId,
        trigger: 'schedule',
        ...(row.suiteId ? { suiteId: row.suiteId } : { testId: row.testId! }),
      },
      // Run carries no createdAt column: newest first via startedAt, then
      // cuid order (≈ time-ordered, same convention as suite-runs.ts).
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    });
  });
}
