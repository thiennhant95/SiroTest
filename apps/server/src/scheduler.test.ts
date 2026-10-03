/**
 * Unit: P1 scheduler — cron matcher, due selection, next-run, and the
 * deps-injected `runDueSchedulesOnce` path (deterministic, no DB/clock).
 *
 * Run: npx tsx --test apps/server/src/scheduler.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetSchedulerStateForTests,
  computeNextRun,
  dueSchedules,
  isValidCron,
  matchesCron,
  parseCron,
  parseCronField,
  runDueSchedulesOnce,
  type ScheduleRow,
  type SchedulerDeps,
} from './scheduler.js';

function at(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

describe('parseCronField', () => {
  it('accepts * and single values', () => {
    assert.deepEqual([...parseCronField('*', 0, 59)!].length, 60);
    assert.deepEqual([...parseCronField('5', 0, 59)!], [5]);
  });
  it('accepts ranges, steps and lists', () => {
    assert.deepEqual([...parseCronField('1-5', 0, 23)!], [1, 2, 3, 4, 5]);
    assert.deepEqual([...parseCronField('*/15', 0, 59)!], [0, 15, 30, 45]);
    assert.deepEqual([...parseCronField('1-10/2', 0, 59)!], [1, 3, 5, 7, 9]);
    assert.deepEqual([...parseCronField('5/15', 0, 59)!], [5, 20, 35, 50]);
    assert.deepEqual([...parseCronField('1,2,3', 0, 59)!], [1, 2, 3]);
    assert.deepEqual([...parseCronField('0,30-33,45', 0, 59)!], [0, 30, 31, 32, 33, 45]);
  });
  it('rejects out-of-range, inverted and malformed fields', () => {
    assert.equal(parseCronField('60', 0, 59), null);
    assert.equal(parseCronField('5-1', 0, 59), null);
    assert.equal(parseCronField('*/0', 0, 59), null);
    assert.equal(parseCronField('5/', 0, 59), null);
    assert.equal(parseCronField('a', 0, 59), null);
    assert.equal(parseCronField('', 0, 59), null);
    assert.equal(parseCronField('1,,2', 0, 59), null);
  });
  it('maps dow 7 to Sunday', () => {
    assert.deepEqual([...parseCronField('7', 0, 6, true)!], [0]);
    assert.deepEqual([...parseCronField('5,7', 0, 6, true)!].sort((a, b) => a - b), [0, 5]);
  });
});

describe('matchesCron', () => {
  // 2026-10-03 is a Saturday.
  const sat = at(2026, 10, 3, 9, 30);
  it('matches every-minute and exact crons', () => {
    assert.equal(matchesCron('* * * * *', sat), true);
    assert.equal(matchesCron('30 9 * * *', sat), true);
    assert.equal(matchesCron('31 9 * * *', sat), false);
  });
  it('supports steps/lists and month scoping', () => {
    assert.equal(matchesCron('*/30 * * * *', sat), true);
    assert.equal(matchesCron('*/30 * * * *', at(2026, 10, 3, 9, 31)), false);
    assert.equal(matchesCron('* * * 10 *', sat), true);
    assert.equal(matchesCron('* * * 11 *', sat), false);
  });
  it('matches dow numerically (Sat=6, Sun 0/7)', () => {
    assert.equal(matchesCron('* * * * 6', sat), true);
    assert.equal(matchesCron('* * * * 0', sat), false);
    assert.equal(matchesCron('* * * * 0', at(2026, 10, 4, 0, 0)), true);
    assert.equal(matchesCron('* * * * 7', at(2026, 10, 4, 0, 0)), true);
  });
  it('applies Vixie dom/dow OR semantics when both are restricted', () => {
    // 1st of month OR Sunday at 00:00.
    assert.equal(matchesCron('0 0 1 * 0', at(2026, 10, 1, 0, 0)), true); // Oct 1 (Thu) — dom hit
    assert.equal(matchesCron('0 0 1 * 0', at(2026, 10, 4, 0, 0)), true); // Sunday — dow hit
    assert.equal(matchesCron('0 0 1 * 0', at(2026, 10, 3, 0, 0)), false); // Sat, not the 1st
    // Single restriction behaves as AND.
    assert.equal(matchesCron('0 0 1 * *', at(2026, 10, 1, 0, 0)), true);
    assert.equal(matchesCron('0 0 1 * *', at(2026, 10, 4, 0, 0)), false);
  });
  it('rejects malformed crons (never due)', () => {
    for (const bad of ['* * * *', '* * * * * *', '61 * * * *', '*/0 * * * *', 'MON * * * *', '']) {
      assert.equal(matchesCron(bad, sat), false, bad);
      assert.equal(isValidCron(bad), false, bad);
    }
    assert.equal(parseCron('* * * * *') !== null, true);
  });
});

describe('dueSchedules', () => {
  const base = { id: 's1', cron: '* * * * *', enabled: true, lastRunAt: null };
  it('fires enabled+matching schedules once per minute', () => {
    const now = at(2026, 10, 3, 9, 30);
    assert.equal(dueSchedules([base], now).length, 1);
    // Already fired this minute → not due again.
    assert.equal(dueSchedules([{ ...base, lastRunAt: at(2026, 10, 3, 9, 30) }], now).length, 0);
    // Fired a previous minute → due again.
    assert.equal(dueSchedules([{ ...base, lastRunAt: at(2026, 10, 3, 9, 29) }], now).length, 1);
  });
  it('skips disabled and non-matching schedules', () => {
    const now = at(2026, 10, 3, 9, 30);
    assert.equal(dueSchedules([{ ...base, enabled: false }], now).length, 0);
    assert.equal(dueSchedules([{ ...base, cron: '0 0 * * *' }], now).length, 0);
    assert.equal(dueSchedules([{ ...base, cron: 'bogus' }], now).length, 0);
  });
});

describe('computeNextRun', () => {
  it('finds the next minute and next midnight', () => {
    const from = at(2026, 10, 3, 9, 30);
    assert.deepEqual(computeNextRun('* * * * *', from), at(2026, 10, 3, 9, 31));
    assert.deepEqual(computeNextRun('0 0 * * *', from), at(2026, 10, 4, 0, 0));
    assert.deepEqual(computeNextRun('*/15 9 * * *', from), at(2026, 10, 3, 9, 45));
  });
  it('returns null for impossible or invalid crons', () => {
    assert.equal(computeNextRun('0 0 30 2 *', at(2026, 10, 3, 9, 30)), null);
    assert.equal(computeNextRun('bogus', at(2026, 10, 3, 9, 30)), null);
  });
});

function row(over: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'sched_1',
    projectId: 'p1',
    suiteId: 'suite_1',
    testId: null,
    environmentId: 'env_1',
    cron: '* * * * *',
    enabled: true,
    retries: 0,
    browser: 'chromium',
    headed: false,
    profileId: null,
    datasetId: null,
    rowIndex: null,
    healWithAlternatives: false,
    lastRunAt: null,
    nextRunAt: null,
    createdBy: 'u1',
    ...over,
  };
}

function fakeDeps(over: Partial<SchedulerDeps> = {}): SchedulerDeps & {
  fired: string[];
  markedFired: string[];
  markedSkipped: string[];
  logs: string[];
} {
  const logs: string[] = [];
  const log = {
    info: (...a: unknown[]) => void logs.push(`info:${a.join(' ')}`),
    warn: (...a: unknown[]) => void logs.push(`warn:${a.join(' ')}`),
    error: (...a: unknown[]) => void logs.push(`error:${a.join(' ')}`),
  };
  const fired: string[] = [];
  const markedFired: string[] = [];
  const markedSkipped: string[] = [];
  return {
    fired,
    markedFired,
    markedSkipped,
    logs,
    log,
    listSchedules: async () => [row()],
    hasActiveRun: async () => false,
    fireSchedule: async (s) => {
      fired.push(s.id);
      return { kind: 'suite', id: 'sr_x' };
    },
    markFired: async (s) => void markedFired.push(s.id),
    markSkipped: async (s) => void markedSkipped.push(s.id),
    ...over,
  };
}

describe('runDueSchedulesOnce', () => {
  it('fires a due schedule and marks lastRunAt', async () => {
    __resetSchedulerStateForTests();
    const deps = fakeDeps();
    const report = await runDueSchedulesOnce(at(2026, 10, 3, 9, 30), deps);
    assert.deepEqual(report, { checked: 1, due: 1, fired: 1, skipped: 0, failed: 0 });
    assert.deepEqual(deps.fired, ['sched_1']);
    assert.deepEqual(deps.markedFired, ['sched_1']);
  });
  it('does not fire twice within the same minute (attempt guard)', async () => {
    __resetSchedulerStateForTests();
    const deps = fakeDeps();
    const now = at(2026, 10, 3, 9, 30);
    await runDueSchedulesOnce(now, deps);
    const second = await runDueSchedulesOnce(now, deps);
    assert.equal(second.fired, 0);
    assert.deepEqual(deps.fired, ['sched_1']);
  });
  it('skips on overlap without firing (nextRunAt still advanced)', async () => {
    __resetSchedulerStateForTests();
    const deps = fakeDeps({ hasActiveRun: async () => true });
    const report = await runDueSchedulesOnce(at(2026, 10, 3, 9, 30), deps);
    assert.deepEqual(report, { checked: 1, due: 1, fired: 0, skipped: 1, failed: 0 });
    assert.deepEqual(deps.fired, []);
    assert.deepEqual(deps.markedSkipped, ['sched_1']);
  });
  it('counts a firing error as failed without crashing the tick', async () => {
    __resetSchedulerStateForTests();
    const bad: ScheduleRow = row({ id: 'bad', cron: 'nope' });
    const deps = fakeDeps({
      listSchedules: async () => [row(), bad],
      fireSchedule: async (s) => {
        if (s.id === 'sched_1') throw new Error('worker boom');
        return { kind: 'test', id: 'r_x' };
      },
    });
    const report = await runDueSchedulesOnce(at(2026, 10, 3, 9, 30), deps);
    // sched_1 failed; invalid-cron 'bad' is skipped with a warning.
    assert.deepEqual(report, { checked: 2, due: 1, fired: 0, skipped: 1, failed: 1 });
    assert.ok(deps.logs.some((l) => l.startsWith('error:') && l.includes('worker boom')));
    assert.ok(deps.logs.some((l) => l.startsWith('warn:') && l.includes('invalid cron')));
  });
  it('ignores non-due schedules', async () => {
    __resetSchedulerStateForTests();
    const deps = fakeDeps({ listSchedules: async () => [row({ cron: '0 0 * * *' })] });
    const report = await runDueSchedulesOnce(at(2026, 10, 3, 9, 30), deps);
    assert.deepEqual(report, { checked: 1, due: 0, fired: 0, skipped: 0, failed: 0 });
  });
});
