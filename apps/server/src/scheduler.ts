/**
 * P1 — Scheduling (in-process ticker; trigger `'schedule'`).
 *
 * Engine boundary (AGENTS.md §1, §2, ADR-001): this module NEVER forks the
 * execution engine. Suite schedules reuse the P1 `enqueueSuiteMember`
 * orchestration (`suite-runs.ts`); single-test schedules replicate the
 * `POST /tests/:id/runs` wiring (runs.ts) field-for-field — validate →
 * create Run row → resolve env/variables → enqueue on the EXISTING `runQueue`
 * (capacity 2) — without modifying any route or schema.
 *
 * Source model: the `Schedule` table (prisma/schema.prisma):
 * `{ projectId, suiteId?, testId?, environmentId, cron, enabled, retries,
 *    lastRunAt, nextRunAt, createdBy }`. A schedule with `suiteId` fires a
 *   suite run (parallel 2, i.e. enqueue all members at once — the shared queue
 *   caps real concurrency); otherwise the `testId` fires a single run. Both
 *   use browser `chromium`, headless (the table carries no browser/headed
 *   columns in P1). `trigger` is always `'schedule'`, `triggeredBy` is the
 *   schedule's `createdBy`.
 *
 * Overlap guard: a schedule whose suite (or test, for test schedules) already
 * has a `queued`/`running` run is skipped for this tick (its `nextRunAt` is
 * still advanced). A per-minute in-memory attempt guard additionally prevents
 * double-firing a failing schedule within the same minute.
 *
 * Cron dialect: 5 fields `minute hour dom month dow`, each supporting `*`,
 * ranges (`1-5`), steps (`*\/15`, `1-10/2`, `5/15` = `5-max/15`) and lists
 * (`1,2,3` and combinations). Numeric only, `dow` 0-6 with 7 accepted as a
 * Sunday alias for single values/lists. `dom`+`dow` follow Vixie semantics:
 * when BOTH are restricted a run fires if EITHER matches. Times are evaluated
 * in the server's local timezone. Invalid crons never fire (warned once per
 * tick).
 *
 * Boot: `startScheduler()` is called from the server entries (`index.ts` and
 * the `app.ts` dev-listen block), guarded by `SKIP_LISTEN=1` (tests/e2e never
 * start the ticker) and `SCHEDULER_DISABLED=1`. A single server instance per
 * database is assumed; `lastRunAt` in the DB is the cross-process guard.
 */
import { runTest } from '@playwright-studio/runner';
import { resolveRunInputs } from './run-inputs.js';
import { db } from './db.js';
import { checkAllowedHttpUrl, stripServerPaths } from './security.js';
import { decryptSecrets, parseProvider, sendToProvider } from './integrations.js';
import { enqueueSuiteMember, newSuiteRunId } from './suite-runs.js';
import {
  broadcastRunEvent,
  markQueuedEmittedByRoute,
  prismaRunStore,
  resolveRunVariables,
  runQueue,
  workerPublish,
} from './runner-store.js';

// ---------------------------------------------------------------------------
// Cron matcher (no new dependency — minimal 5-field matcher)
// ---------------------------------------------------------------------------

interface FieldRange {
  min: number;
  max: number;
}

const CRON_RANGES: FieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week (7 → 0 Sunday alias, normalized per atom)
];

/** Parse one cron field into the accepted value set, or null when invalid. */
export function parseCronField(field: string, min: number, max: number, isDow = false): Set<number> | null {
  const text = field.trim();
  if (text.length === 0) return null;
  const out = new Set<number>();
  const norm = (n: number): number | null => {
    const v = isDow && n === 7 ? 0 : n;
    if (!Number.isInteger(v) || v < min || v > max) return null;
    return v;
  };
  const parseAtom = (atom: string): number | null => {
    if (!/^\d+$/.test(atom)) return null;
    return norm(Number(atom));
  };
  for (const part of text.split(',')) {
    const item = part.trim();
    if (item.length === 0) return null;
    const [rangePart, stepPart] = item.split('/');
    if (stepPart !== undefined) {
      // Step without '/' remainder is illegal (`5/`); empty step too.
      if (stepPart.length === 0 || !/^\d+$/.test(stepPart)) return null;
      const step = Number(stepPart);
      if (!Number.isInteger(step) || step < 1) return null;
      let start: number;
      let end: number;
      if (rangePart === '' || rangePart === '*') {
        start = min;
        end = max;
      } else if (rangePart.includes('-')) {
        const [a, b] = rangePart.split('-');
        const lo = parseAtom((a ?? '').trim());
        const hi = parseAtom((b ?? '').trim());
        if (lo === null || hi === null || lo > hi) return null;
        start = lo;
        end = hi;
      } else {
        const lo = parseAtom(rangePart.trim());
        if (lo === null) return null;
        start = lo;
        end = max;
      }
      for (let v = start; v <= end; v += step) out.add(v);
      continue;
    }
    if (rangePart === '*') {
      for (let v = min; v <= max; v++) out.add(v);
      continue;
    }
    if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      const lo = parseAtom((a ?? '').trim());
      const hi = parseAtom((b ?? '').trim());
      if (lo === null || hi === null || lo > hi) return null;
      for (let v = lo; v <= hi; v++) out.add(v);
      continue;
    }
    const single = parseAtom(rangePart.trim());
    if (single === null) return null;
    out.add(single);
  }
  return out.size > 0 ? out : null;
}

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

/** Parse a 5-field cron expression, or null when invalid. */
export function parseCron(cron: string): ParsedCron | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteF, hourF, domF, monthF, dowF] = fields as [string, string, string, string, string];
  const sets: Array<Set<number> | null> = fields.map((f, i) => {
    const r = CRON_RANGES[i]!;
    return parseCronField(f, r.min, r.max, i === 4);
  });
  const [minute, hour, dom, month, dow] = sets;
  if (!minute || !hour || !dom || !month || !dow) return null;
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: domF !== '*',
    dowRestricted: dowF !== '*',
  };
}

/** True when the cron string is syntactically valid (5 fields, in range). */
export function isValidCron(cron: string): boolean {
  return parseCron(cron) !== null;
}

const CRON_FIELD_NAMES = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'] as const;

/**
 * Single-source cron validation with a human reason (route maps to
 * CRON_INVALID). Same parser the ticker uses — route and ticker can never
 * disagree about what a valid expression is.
 */
export function cronIssue(cron: string): string | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    return `cron must have exactly 5 fields (minute hour dom month dow), got ${fields.length}`;
  }
  for (let i = 0; i < 5; i++) {
    const r = CRON_RANGES[i]!;
    const parsed = parseCronField(fields[i]!, r.min, r.max, i === 4);
    if (parsed === null) {
      const shownMax = i === 4 ? '0-6 (7 = Sunday alias)' : `${r.min}-${r.max}`;
      return `cron field ${i + 1} (${CRON_FIELD_NAMES[i]}, "${fields[i]}") is out of range ${shownMax} or malformed`;
    }
  }
  return null;
}

/** True when `cron` fires at `at` (server-local time). Invalid crons → false. */
export function matchesCron(cron: string, at: Date): boolean {
  const parsed = parseCron(cron);
  if (!parsed) return false;
  if (!parsed.minute.has(at.getMinutes())) return false;
  if (!parsed.hour.has(at.getHours())) return false;
  if (!parsed.month.has(at.getMonth() + 1)) return false;
  const domMatch = parsed.dom.has(at.getDate());
  const dowMatch = parsed.dow.has(at.getDay());
  // Vixie semantics: both restricted → EITHER fires; else the restricted one
  // (or always, when neither is restricted) must match.
  if (parsed.domRestricted && parsed.dowRestricted) return domMatch || dowMatch;
  if (parsed.domRestricted) return domMatch;
  if (parsed.dowRestricted) return dowMatch;
  return true;
}

/** Floor a timestamp to the start of its minute (per-minute fire granularity). */
export function startOfMinute(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes(), 0, 0);
}

/**
 * Next minute-granularity occurrence strictly after `from`, or null when no
 * occurrence exists within ~366 days (e.g. `0 0 30 2 *`).
 */
export function computeNextRun(cron: string, from: Date): Date | null {
  if (!isValidCron(cron)) return null;
  let cursor = startOfMinute(from).getTime() + 60_000;
  const limit = cursor + 366 * 24 * 60 * 60_000;
  for (; cursor <= limit; cursor += 60_000) {
    if (matchesCron(cron, new Date(cursor))) return new Date(cursor);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pure due selection (deterministic — unit-tested, reused by the ticker)
// ---------------------------------------------------------------------------

export interface ScheduleLike {
  id: string;
  cron: string;
  enabled: boolean;
  lastRunAt: Date | null;
}

/**
 * Schedules that must fire at `now`: enabled, cron matches this minute, and
 * not already fired within the current minute (`lastRunAt` from a previous
 * tick or process).
 */
export function dueSchedules<T extends ScheduleLike>(schedules: T[], now: Date): T[] {
  const floor = startOfMinute(now).getTime();
  return schedules.filter((s) => {
    if (!s.enabled) return false;
    if (!matchesCron(s.cron, now)) return false;
    if (s.lastRunAt === null) return true;
    const last = s.lastRunAt instanceof Date ? s.lastRunAt.getTime() : new Date(s.lastRunAt).getTime();
    if (!Number.isFinite(last)) return true;
    return last < floor;
  });
}

// ---------------------------------------------------------------------------
// Ticker orchestration (injectable deps — deterministic in tests)
// ---------------------------------------------------------------------------

export interface ScheduleRow extends ScheduleLike {
  projectId: string;
  suiteId: string | null;
  testId: string | null;
  environmentId: string;
  retries: number;
  browser: string;
  headed: boolean;
  profileId: string | null;
  datasetId: string | null;
  rowIndex: number | null;
  healWithAlternatives: boolean;
  notifyOnFailure: boolean;
  lastStatus: string | null;
  nextRunAt: Date | null;
  createdBy: string;
}

export interface SchedulerLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface SchedulerDeps {
  listSchedules(): Promise<ScheduleRow[]>;
  hasActiveRun(s: ScheduleRow): Promise<boolean>;
  fireSchedule(s: ScheduleRow, now: Date): Promise<{ kind: 'suite' | 'test'; id: string }>;
  markFired(s: ScheduleRow, now: Date): Promise<void>;
  markSkipped(s: ScheduleRow, now: Date): Promise<void>;
  log: SchedulerLogger;
}

export interface SchedulerTickReport {
  checked: number;
  due: number;
  fired: number;
  skipped: number;
  failed: number;
}

function consoleLogger(): SchedulerLogger {
  return {
    info: (...args: unknown[]) => console.log('[scheduler]', ...args),
    warn: (...args: unknown[]) => console.warn('[scheduler]', ...args),
    error: (...args: unknown[]) => console.error('[scheduler]', ...args),
  };
}

function nextRunFields(cron: string, from: Date): { nextRunAt: Date | null } {
  return { nextRunAt: computeNextRun(cron, from) };
}

/** Default firing path — direct DB + queue orchestration (no route involved). */
async function defaultFireSchedule(s: ScheduleRow, _now: Date): Promise<{ kind: 'suite' | 'test'; id: string }> {
  if (s.suiteId) return { kind: 'suite', id: await fireSuiteSchedule(s) };
  if (s.testId) return { kind: 'test', id: await fireTestSchedule(s) };
  throw new Error(`Schedule ${s.id} has neither suiteId nor testId`);
}

/**
 * Suite fire path — mirrors POST /suites/:sid/runs with `parallel: 2`
 * (suites.ts): create every member row now via `enqueueSuiteMember`, let the
 * shared `runQueue(2)` cap real concurrency. Fire-and-forget after row
 * creation (route returns 202 the same way); retry orchestration lives in
 * `enqueueSuiteMember` (`trigger` + `retriesLeft`).
 */
async function fireSuiteSchedule(s: ScheduleRow): Promise<string> {
  const suite = await db().testSuite.findUnique({
    where: { id: s.suiteId! },
    include: {
      tests: {
        orderBy: { sortOrder: 'asc' },
        include: { test: { select: { id: true, name: true, projectId: true } } },
      },
    },
  });
  if (!suite) throw new Error(`Suite ${s.suiteId} not found`);
  if (suite.projectId !== s.projectId) {
    throw new Error(`Suite ${s.suiteId} does not belong to project ${s.projectId}`);
  }
  if (suite.tests.length === 0) throw new Error(`Suite ${s.suiteId} has no tests`);
  const env = await db().environment.findUnique({ where: { id: s.environmentId } });
  if (!env || env.projectId !== suite.projectId) {
    throw new Error('environmentId does not belong to this project');
  }
  // SSRF guard (same rule as single-test + suite runs): env baseUrl wins,
  // else the project baseUrl must be an allowed public http(s) URL.
  const project = await db().project.findUnique({ where: { id: suite.projectId } });
  const urlCheck = checkAllowedHttpUrl(env.baseUrl ?? project?.baseUrl ?? null);
  if (!urlCheck.ok) throw new Error(`run target rejected: ${urlCheck.reason}`);
  const fullTests = await db().test.findMany({ where: { id: { in: suite.tests.map((t) => t.testId) } } });
  const byId = new Map(fullTests.map((t) => [t.id, t]));
  const ordered = suite.tests.map((m) => byId.get(m.testId)).filter((t) => t !== undefined);
  if (ordered.length === 0) throw new Error(`Suite ${s.suiteId} has no resolvable tests`);

  const suiteRunId = newSuiteRunId();
  const starters = await Promise.all(
    ordered.map((t) =>
      enqueueSuiteMember(runTest, {
        projectId: suite.projectId,
        environmentId: s.environmentId,
        browser: (s.browser === 'firefox' || s.browser === 'webkit' ? s.browser : 'chromium') as 'chromium' | 'firefox' | 'webkit',
        headed: s.headed,
        trigger: 'suite',
        suiteId: s.suiteId!,
        suiteRunId,
        triggeredBy: s.createdBy,
        retriesLeft: Math.max(0, Math.min(5, s.retries)),
        testId: t!.id,
        definitionJson: t!.definitionJson,
        ...(s.profileId ? { profileId: s.profileId } : {}),
        ...(s.healWithAlternatives ? { healWithAlternatives: true as const } : {}),
        ...(s.datasetId ? { datasetId: s.datasetId } : {}),
        ...(s.rowIndex !== null && s.rowIndex !== undefined ? { rowIndex: s.rowIndex } : {}),
      }),
    ),
  );
  void Promise.allSettled(starters.map((x) => x.done))
    .then(async (results) => {
      // Suite aggregate: any failure fails the schedule (cancelled counts
      // as failed for alerting — a cancelled nightly is still worth a look).
      const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value : 'failed'));
      const status: ScheduleTerminalStatus = statuses.every((x) => x === 'passed') ? 'passed' : 'failed';
      await onScheduleRunSettled(s.id, { status, suiteRunId });
    })
    .catch(() => {
      /* settle reporting is best-effort; member rows already settled */
    });
  return suiteRunId;
}

/**
 * Failure alerting (opt-in per schedule via `notifyOnFailure`).
 *
 * The ticker is fire-and-forget, so settlement is reported back here by the
 * submit callbacks: every fired run updates `Schedule.lastStatus` (visible
 * in list/detail without polling runs), and a `failed` outcome with
 * `notifyOnFailure` posts to the project's ENABLED slack/lark integrations.
 * Best-effort throughout: notification failures are logged, never crash the
 * ticker, never retry (the next firing alerts again if still failing).
 */
export type ScheduleTerminalStatus = 'passed' | 'failed' | 'cancelled';

export async function onScheduleRunSettled(
  scheduleId: string,
  outcome: { status: ScheduleTerminalStatus; runId?: string; suiteRunId?: string; errorSummary?: string | null },
  log: SchedulerLogger = consoleLogger(),
): Promise<void> {
  const s = await db().schedule.findUnique({ where: { id: scheduleId } });
  if (!s) return;
  await db().schedule.update({ where: { id: scheduleId }, data: { lastStatus: outcome.status } }).catch(() => undefined);
  if (outcome.status !== 'failed' || !s.notifyOnFailure) return;
  await notifyScheduleFailure(
    { id: s.id, projectId: s.projectId, suiteId: s.suiteId, testId: s.testId, cron: s.cron },
    outcome,
    log,
  );
}

async function notifyScheduleFailure(
  s: { id: string; projectId: string; suiteId: string | null; testId: string | null; cron: string },
  outcome: { status: ScheduleTerminalStatus; runId?: string; suiteRunId?: string; errorSummary?: string | null },
  log: SchedulerLogger,
): Promise<void> {
  try {
    const integrations = await db().integration.findMany({
      where: { projectId: s.projectId, enabled: true, provider: { in: ['slack', 'lark'] } },
    });
    if (integrations.length === 0) {
      log.info(`schedule ${s.id} failed but no enabled slack/lark integration to notify`);
      return;
    }
    let target = s.cron;
    if (s.suiteId) {
      const suite = await db().testSuite.findUnique({ where: { id: s.suiteId }, select: { name: true } });
      target = `suite "${suite?.name ?? s.suiteId}"`;
    } else if (s.testId) {
      const test = await db().test.findUnique({ where: { id: s.testId }, select: { name: true } });
      target = `test "${test?.name ?? s.testId}"`;
    }
    const ref = outcome.suiteRunId ? `suite run ${outcome.suiteRunId}` : outcome.runId ? `run ${outcome.runId}` : 'run (unknown)';
    const title = `[Studio] schedule FAILED: ${target} (${s.cron})`;
    // errorSummary is runner-redacted (secrets stripped before persist).
    const markdown = `${ref}\n${outcome.errorSummary ?? 'no error summary'}`.slice(0, 2000);
    for (const row of integrations) {
      try {
        const config = JSON.parse(row.configJson || '{}') as Record<string, string>;
        await sendToProvider(parseProvider(row.provider), config, decryptSecrets(row.secretJson), { title, markdown });
        log.info(`schedule ${s.id} failure notified via ${row.provider} "${row.name}"`);
      } catch (err) {
        log.error(`schedule ${s.id} notify via ${row.provider} failed`, err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    log.error(`schedule ${s.id} notify failed`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Single-test fire path — mirrors POST /tests/:id/runs (runs.ts) without
 * P1 dataset selection (schedules carry no dataset columns in P1): validate
 * → create Run row (`trigger: 'schedule'`) → resolve env/variables + project
 * actions → submit to the shared queue. Fire-and-forget with the route's
 * last-resort crash-settle guard.
 */
async function fireTestSchedule(s: ScheduleRow): Promise<string> {
  const test = await db().test.findUnique({ where: { id: s.testId! } });
  if (!test) throw new Error(`Test ${s.testId} not found`);
  if (test.projectId !== s.projectId) {
    throw new Error(`Test ${s.testId} does not belong to project ${s.projectId}`);
  }
  const env = await db().environment.findUnique({ where: { id: s.environmentId } });
  if (!env || env.projectId !== test.projectId) {
    throw new Error('environmentId does not belong to this project');
  }
  const project = await db().project.findUnique({ where: { id: test.projectId } });
  const urlCheck = checkAllowedHttpUrl(env.baseUrl ?? project?.baseUrl ?? null);
  if (!urlCheck.ok) throw new Error(`run target rejected: ${urlCheck.reason}`);
  const definition = JSON.parse(test.definitionJson) as Parameters<typeof runTest>[0]['test'];
  // Schedule-level data selection honours the same rules as manual triggers:
  // unknown dataset / bad row fails THIS firing explicitly (never wrong data).
  if (s.datasetId) {
    const datasets = (Array.isArray((definition as { datasets?: unknown }).datasets)
      ? (definition as { datasets: Array<{ id?: unknown; rows?: unknown }> }).datasets
      : []);
    const found = datasets.find((d) => d.id === s.datasetId);
    if (!found) throw new Error(`dataset '${s.datasetId}' does not exist in test ${test.id}`);
    if (s.rowIndex !== null && s.rowIndex !== undefined) {
      const n = Array.isArray(found.rows) ? found.rows.length : 0;
      if (!Number.isInteger(s.rowIndex) || s.rowIndex < 0 || s.rowIndex >= n) {
        throw new Error(`rowIndex ${s.rowIndex} out of range for dataset '${s.datasetId}' (${n} row(s))`);
      }
    }
  } else if (s.rowIndex !== null && s.rowIndex !== undefined) {
    throw new Error('rowIndex requires datasetId');
  }
  const run = await db().run.create({
    data: {
      projectId: test.projectId,
      testId: test.id,
      environmentId: s.environmentId,
      browser: s.browser,
      status: 'queued',
      trigger: 'schedule',
      ...(s.datasetId ? { datasetId: s.datasetId } : {}),
      ...(s.rowIndex !== null && s.rowIndex !== undefined ? { rowIndex: s.rowIndex } : {}),
    },
  });
  broadcastRunEvent('run.queued', run.id, { testId: test.id });
  markQueuedEmittedByRoute(run.id);
  const { projectVariables, environmentVariables } = await resolveRunVariables(test.projectId, s.environmentId);
  // Same P1 inputs as route-triggered runs (actions + upload files). No
  // profile: schedules carry no profile column in P1 (documented).
  const inputs = await resolveRunInputs(test.projectId, definition, {
    environmentId: s.environmentId,
    ...(s.profileId ? { profileId: s.profileId } : {}),
  });
  const request: Parameters<typeof runTest>[0] = {
    runId: run.id,
    test: definition,
    projectId: test.projectId,
    environmentId: s.environmentId,
    browser: (s.browser === 'firefox' || s.browser === 'webkit' ? s.browser : 'chromium') as 'chromium' | 'firefox' | 'webkit',
    headed: s.headed,
    ...(s.datasetId ? { datasetId: s.datasetId } : {}),
    ...(s.rowIndex !== null && s.rowIndex !== undefined ? { rowIndex: s.rowIndex } : {}),
    ...(inputs.actions.length > 0 ? { actions: inputs.actions } : {}),
    ...(inputs.filePaths !== undefined ? { filePaths: inputs.filePaths } : {}),
    ...(inputs.storageStateJson !== undefined ? { storageStateJson: inputs.storageStateJson } : {}),
    ...(s.healWithAlternatives ? { healWithAlternatives: true as const } : {}),
    projectVariables,
    environmentVariables,
    trigger: 'schedule',
    triggeredBy: s.createdBy,
  };
  void runQueue
    .submit(run.id, async () => {
      // Same queued-cancel-wins guard as runs.ts: never execute (and thus
      // never resurrect) a run a cancel already settled.
      const current = await prismaRunStore.getRun(run.id);
      if (current?.status === 'cancelled') return { status: 'cancelled' as const, runId: run.id };
      return runTest(request, { store: prismaRunStore, publish: workerPublish });
    })
    .then(async (result) => {
      // Settlement reporting: lastStatus + opt-in failure alert (best-effort).
      const status = result.status === 'passed' ? 'passed' : result.status === 'cancelled' ? 'cancelled' : 'failed';
      const settled = await prismaRunStore.getRun(run.id).catch(() => null);
      await onScheduleRunSettled(s.id, {
        status,
        runId: run.id,
        errorSummary: settled?.errorSummary ?? null,
      });
      return result;
    })
    .catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      await prismaRunStore.updateRun(run.id, {
        status: 'failed',
        finishedAt: Date.now(),
        errorSummary: stripServerPaths(`Worker crashed before settling: ${message}`),
      });
      await onScheduleRunSettled(s.id, { status: 'failed', runId: run.id, errorSummary: message });
    });
  return run.id;
}

async function defaultHasActiveRun(s: ScheduleRow): Promise<boolean> {
  const active: string[] = ['queued', 'running'];
  if (s.suiteId) {
    const existing = await db().run.findFirst({ where: { suiteId: s.suiteId, status: { in: active } }, select: { id: true } });
    return existing !== null;
  }
  const existing = await db().run.findFirst({
    where: { testId: s.testId!, trigger: 'schedule', status: { in: active } },
    select: { id: true },
  });
  return existing !== null;
}

/** Default DB-backed deps (production wiring; tests inject fakes). */
export function defaultSchedulerDeps(log: SchedulerLogger = consoleLogger()): SchedulerDeps {
  return {
    log,
    listSchedules: async () => {
      const rows = await db().schedule.findMany({ where: { enabled: true } });
      return rows.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        suiteId: r.suiteId,
        testId: r.testId,
        environmentId: r.environmentId,
        cron: r.cron,
        enabled: r.enabled,
        retries: r.retries,
        browser: r.browser,
        headed: r.headed,
        profileId: r.profileId,
        datasetId: r.datasetId,
        rowIndex: r.rowIndex,
        healWithAlternatives: r.healWithAlternatives,
        notifyOnFailure: r.notifyOnFailure ?? false,
        lastStatus: r.lastStatus ?? null,
        lastRunAt: r.lastRunAt,
        nextRunAt: r.nextRunAt,
        createdBy: r.createdBy,
      }));
    },
    hasActiveRun: defaultHasActiveRun,
    fireSchedule: defaultFireSchedule,
    markFired: async (s, now) => {
      await db().schedule.update({
        where: { id: s.id },
        data: { lastRunAt: now, ...nextRunFields(s.cron, now) },
      });
    },
    markSkipped: async (s, now) => {
      await db().schedule.update({
        where: { id: s.id },
        data: { ...nextRunFields(s.cron, now) },
      });
    },
  };
}

/**
 * Same-minute attempt guard: a schedule that errored (or raced) must not be
 * re-fired every tick for the rest of its due minute. In-memory per process;
 * `lastRunAt` in the DB is the cross-process guard. Exported reset exists for
 * deterministic tests.
 */
const attemptMinuteBySchedule = new Map<string, number>();

export function __resetSchedulerStateForTests(): void {
  attemptMinuteBySchedule.clear();
}

/**
 * One scheduler pass: load enabled schedules, fire those due at `now`.
 * A single schedule's failure (invalid cron, missing suite/env, worker error)
 * is caught, logged and counted — it never crashes the ticker or blocks
 * other schedules. Deterministic under injected `deps` (no clock/DB inside).
 */
export async function runDueSchedulesOnce(
  now: Date = new Date(),
  deps: SchedulerDeps = defaultSchedulerDeps(),
): Promise<SchedulerTickReport> {
  const report: SchedulerTickReport = { checked: 0, due: 0, fired: 0, skipped: 0, failed: 0 };
  let schedules: ScheduleRow[];
  try {
    schedules = await deps.listSchedules();
  } catch (err) {
    deps.log.error('scheduler list failed', err instanceof Error ? err.message : String(err));
    return report;
  }
  report.checked = schedules.length;
  const floor = startOfMinute(now).getTime();
  for (const s of schedules) {
    try {
      if (!s.enabled) continue;
      if (!isValidCron(s.cron)) {
        deps.log.warn(`schedule ${s.id} has invalid cron '${s.cron}' — skipped`);
        report.skipped += 1;
        continue;
      }
      if (dueSchedules([s], now).length === 0) continue;
      report.due += 1;
      if (attemptMinuteBySchedule.get(s.id) === floor) {
        report.skipped += 1;
        continue;
      }
      attemptMinuteBySchedule.set(s.id, floor);
      if (await deps.hasActiveRun(s)) {
        deps.log.info(`schedule ${s.id} skipped: previous run still queued/running`);
        await deps.markSkipped(s, now);
        report.skipped += 1;
        continue;
      }
      const fired = await deps.fireSchedule(s, now);
      await deps.markFired(s, now);
      deps.log.info(`schedule ${s.id} fired ${fired.kind} ${fired.id}`);
      report.fired += 1;
    } catch (err) {
      report.failed += 1;
      deps.log.error(`schedule ${s.id} failed`, err instanceof Error ? err.message : String(err));
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Ticker lifecycle
// ---------------------------------------------------------------------------

let ticker: ReturnType<typeof setInterval> | null = null;

/** Stop the ticker (idempotent). Returned by `startScheduler`. */
export function stopScheduler(): void {
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

/** True while the in-process ticker is active. */
export function isSchedulerRunning(): boolean {
  return ticker !== null;
}

function schedulerIntervalMs(): number {
  const raw = Number(process.env.SCHEDULER_INTERVAL_MS ?? 60_000);
  if (!Number.isFinite(raw) || raw <= 0) return 60_000;
  // Never hammer the DB faster than every 5s from the in-process ticker;
  // sub-minute precision is not needed (fire granularity is per minute).
  return Math.max(5_000, Math.floor(raw));
}

/**
 * Start the in-process scheduling ticker. Idempotent per process: a second
 * call logs a warning and returns the shared stop handle. The handle also
 * `unref`s the timer so it never keeps a process alive on its own (the HTTP
 * listener owns the process lifetime, not the ticker).
 */
export function startScheduler(opts: { intervalMs?: number; log?: SchedulerLogger } = {}): () => void {
  const log = opts.log ?? consoleLogger();
  if (ticker !== null) {
    log.warn('scheduler already running — ignoring duplicate start');
    return stopScheduler;
  }
  const intervalMs = opts.intervalMs ?? schedulerIntervalMs();
  const tick = (): void => {
    runDueSchedulesOnce(new Date(), defaultSchedulerDeps(log)).catch((err: unknown) => {
      log.error('scheduler tick crashed', err instanceof Error ? err.message : String(err));
    });
  };
  void tick();
  ticker = setInterval(tick, intervalMs);
  if (typeof (ticker as unknown as { unref?: () => void }).unref === 'function') {
    (ticker as unknown as { unref: () => void }).unref();
  }
  log.info(`scheduler started (interval ${intervalMs}ms)`);
  return stopScheduler;
}
