/**
 * Unit: command execution — polling, exit codes, summaries, export writing,
 * trigger-schedules wiring (all I/O mocked; token-leak assertions).
 * Run: npx tsx --test apps/cli/src/commands.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { main, type MainDeps } from './commands.js';
import type { MinimalResponse } from './api.js';

const TOKEN = 'super-secret-token';
const ENV = { STUDIO_API_URL: 'http://api:3001', STUDIO_TOKEN: TOKEN };

function json(status: number, body: unknown): MinimalResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}
function text(status: number, body: string): MinimalResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

interface Harness {
  deps: MainDeps;
  stdout: string[];
  stderr: string[];
  files: Map<string, string>;
  nowValue: number;
}

function harness(responses: MinimalResponse[] | ((url: string) => MinimalResponse), opts: { now?: number } = {}): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const files = new Map<string, string>();
  let i = 0;
  const list = Array.isArray(responses) ? responses : null;
  const state = { now: opts.now ?? 1_000_000 };
  const deps: MainDeps = {
    env: { ...ENV },
    fetchFn: async (url: string) => {
      if (list) {
        const r = list[Math.min(i++, list.length - 1)]!;
        return r;
      }
      return (responses as (url: string) => MinimalResponse)(url);
    },
    out: (m) => void stdout.push(m),
    err: (m) => void stderr.push(m),
    writeFile: async (p, c) => void files.set(p, c),
    sleep: async () => {},
    now: () => state.now,
    loadServerScheduler: async () => {
      throw new Error('no scheduler in this test');
    },
    setEnv: (k, v) => void (deps.env[k] = v),
  };
  return {
    deps, stdout, stderr, files,
    get nowValue() {
      return state.now;
    },
  };
}

function assertNoTokenLeak(h: Harness): void {
  for (const line of [...h.stdout, ...h.stderr]) {
    assert.ok(!line.includes(TOKEN), `token leaked: ${line}`);
  }
  for (const content of h.files.values()) {
    assert.ok(!content.includes(TOKEN), 'token leaked into file');
  }
}

describe('run --wait exit codes', () => {
  it('passed -> 0 with summary + artifacts', async () => {
    const h = harness([
      json(202, { id: 'run_1', status: 'queued' }),
      json(200, { id: 'run_1', status: 'running' }),
      json(200, {
        id: 'run_1', status: 'passed', durationMs: 123,
        steps: [{ status: 'passed' }, { status: 'passed' }],
        artifacts: [{ type: 'screenshot', path: 'runs/run_1/shot.png' }],
      }),
      // Final summary re-read clamps to the last response above.
    ]);
    const code = await main(['run', '--test', 't1', '--env', 'e1', '--wait'], h.deps);
    assert.equal(code, 0);
    assert.ok(h.stdout.some((l) => l.includes('run run_1: passed')));
    assert.ok(h.stdout.some((l) => l.includes('runs/run_1/shot.png')));
    assertNoTokenLeak(h);
  });
  it('failed -> 1, cancelled -> 2', async () => {
    const fail = harness([
      json(202, { id: 'run_2', status: 'queued' }),
      json(200, { id: 'run_2', status: 'failed', errorSummary: 'boom' }),
      json(200, { id: 'run_2', status: 'failed', errorSummary: 'boom' }),
    ]);
    assert.equal(await main(['run', '--test', 't1', '--env', 'e1', '--wait'], fail.deps), 1);
    assert.ok(fail.stdout.some((l) => l.includes('boom')));
    assertNoTokenLeak(fail);
    const cancelled = harness([
      json(202, { id: 'run_3', status: 'queued' }),
      json(200, { id: 'run_3', status: 'cancelled' }),
      json(200, { id: 'run_3', status: 'cancelled' }),
    ]);
    assert.equal(await main(['run', '--test', 't1', '--env', 'e1', '--wait'], cancelled.deps), 2);
    assertNoTokenLeak(cancelled);
  });
  it('no --wait prints the run id and exits 0', async () => {
    const h = harness([json(202, { id: 'run_9', status: 'queued' })]);
    const code = await main(['run', '--test', 't1', '--env', 'e1'], h.deps);
    assert.equal(code, 0);
    assert.ok(h.stdout.some((l) => l.includes('run_9')));
    assertNoTokenLeak(h);
  });
  it('wait timeout -> 3', async () => {
    const h = harness([json(202, { id: 'run_t', status: 'queued' }), json(200, { id: 'run_t', status: 'running' })]);
    // Advance the clock on every read so the deadline passes deterministically.
    let n = 0;
    h.deps.now = () => 1_000_000 + n++ * 60_000;
    const code = await main(['run', '--test', 't1', '--env', 'e1', '--wait', '--timeout-ms', '1000', '--interval-ms', '100'], h.deps);
    assert.equal(code, 3);
    assertNoTokenLeak(h);
  });
  it('API start failure -> 1', async () => {
    const h = harness([json(400, { code: 'VALIDATION_ERROR', message: 'bad env' })]);
    assert.equal(await main(['run', '--test', 't1', '--env', 'e1', '--wait'], h.deps), 1);
    assertNoTokenLeak(h);
  });
});

describe('suite-run', () => {
  it('polls the suite-run endpoint and exits by aggregate status', async () => {
    const h = harness([
      json(202, { suiteRunId: 'sr_1', status: 'queued' }),
      json(200, { suiteRunId: 'sr_1', status: 'running', tests: [] }),
      json(200, {
        suiteRunId: 'sr_1', status: 'failed',
        tests: [{ testId: 't1', testName: 'login', finalStatus: 'failed' }],
      }),
      json(200, { suiteRunId: 'sr_1', status: 'failed', tests: [{ testId: 't1', testName: 'login', finalStatus: 'failed' }] }),
    ]);
    const code = await main(['suite-run', '--suite', 's1', '--env', 'e1', '--wait'], h.deps);
    assert.equal(code, 1);
    assert.ok(h.stdout.some((l) => l.includes('login: failed')));
    assertNoTokenLeak(h);
  });
});

describe('export', () => {
  it('writes spec/junit files', async () => {
    const h = harness((url: string) => (url.includes('/export') ? text(200, 'CONTENT') : json(200, {})));
    assert.equal(await main(['export', '--test', 't1', '-o', 'a.spec.ts'], h.deps), 0);
    assert.equal(h.files.get('a.spec.ts'), 'CONTENT');
    assert.equal(await main(['export', '--run', 'r1', '-o', 'j.xml'], h.deps), 0);
    assert.equal(h.files.get('j.xml'), 'CONTENT');
    assert.equal(await main(['export', '--suite-run', 'sr1', '-o', 's.xml'], h.deps), 0);
    assertNoTokenLeak(h);
  });
});

describe('trigger-schedules --once', () => {
  it('reports counts and exits 0 (1 when schedules failed)', async () => {
    const h = harness([]);
    h.deps.loadServerScheduler = async () => ({
      runDueSchedulesOnce: async () => ({ checked: 3, due: 2, fired: 1, skipped: 1, failed: 0 }),
    });
    assert.equal(await main(['trigger-schedules', '--once'], { ...h.deps, env: { DATABASE_URL: 'file:x.db' } }), 0);
    assert.ok(h.stdout.some((l) => l.includes('checked=3') && l.includes('fired=1')));
    const h2 = harness([]);
    h2.deps.loadServerScheduler = async () => ({
      runDueSchedulesOnce: async () => ({ checked: 1, due: 1, fired: 0, skipped: 0, failed: 1 }),
    });
    assert.equal(await main(['trigger-schedules', '--once'], { ...h2.deps, env: { DATABASE_URL: 'file:x.db' } }), 1);
  });
});

describe('usage errors', () => {
  it('exit 64 with help on bad args', async () => {
    const h = harness([]);
    assert.equal(await main(['run', '--test', 't1'], h.deps), 64);
    assert.ok(h.stderr.some((l) => l.includes('Error:')));
  });
});
