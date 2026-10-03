/**
 * Command execution for the Studio CI CLI.
 *
 * Every command takes an explicit context (client factory, stdout/stderr,
 * file writer, sleep, clock, scheduler loader) so tests drive the full flow
 * — polling, exit codes, artifact links — with mocked I/O and assert the
 * token never reaches any output.
 */
import { StudioClient, StudioApiError, type FetchFn, type RunJson, type SuiteRunJson } from './api.js';
import {
  EXIT_CANCELLED,
  EXIT_FAILED,
  EXIT_PASSED,
  EXIT_TIMEOUT,
  EXIT_USAGE,
  UsageError,
  parseArgs,
  type ParsedCommand,
} from './args.js';
import { HELP_TEXT, helpFor } from './help.js';

export interface TriggerReport {
  checked: number;
  due: number;
  fired: number;
  skipped: number;
  failed: number;
}

export interface ServerSchedulerModule {
  runDueSchedulesOnce(now?: Date): Promise<TriggerReport>;
}

export interface CommandContext {
  fetchFn?: FetchFn;
  out: (msg: string) => void;
  err: (msg: string) => void;
  writeFile: (path: string, content: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Loader for the server scheduler (trigger-schedules --once, local mode). */
  loadServerScheduler: (serverDist?: string) => Promise<ServerSchedulerModule>;
  setEnv: (key: string, value: string) => void;
}

export function defaultLoadServerScheduler(): Promise<ServerSchedulerModule> {
  throw new Error(
    'trigger-schedules --once must run on the server host: pass a scheduler loader ' +
      '(default wiring lives in src/index.ts)',
  );
}

const TERMINAL_RUN = new Set(['passed', 'failed', 'cancelled']);

export function exitCodeForStatus(status: string): number {
  if (status === 'passed') return EXIT_PASSED;
  if (status === 'cancelled') return EXIT_CANCELLED;
  return EXIT_FAILED;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'n/a';
  return `${ms}ms`;
}

function summarizeRun(run: RunJson): string[] {
  const lines = [`run ${run.id}: ${run.status} (${formatDuration(run.durationMs)})`];
  if (Array.isArray(run.steps) && run.steps.length > 0) {
    const passed = run.steps.filter((s) => s.status === 'passed').length;
    lines.push(`steps: ${passed}/${run.steps.length} passed`);
  }
  if (run.errorSummary) lines.push(`error: ${run.errorSummary.slice(0, 2000)}`);
  if (Array.isArray(run.artifacts) && run.artifacts.length > 0) {
    lines.push('artifacts:');
    for (const a of run.artifacts) lines.push(`  - ${a.type ?? 'artifact'} ${a.path ?? ''}`.trimEnd());
  }
  return lines;
}

function summarizeSuiteRun(suite: SuiteRunJson): string[] {
  const lines = [`suite-run ${suite.suiteRunId}: ${suite.status}`];
  if (Array.isArray(suite.tests)) {
    const counts = { passed: 0, failed: 0, cancelled: 0, other: 0 };
    for (const t of suite.tests) {
      const s = t.finalStatus ?? 'unknown';
      if (s === 'passed') counts.passed += 1;
      else if (s === 'failed') counts.failed += 1;
      else if (s === 'cancelled') counts.cancelled += 1;
      else counts.other += 1;
      lines.push(`  - ${t.testName ?? t.testId ?? '?'}: ${s}`);
    }
    lines.push(`tests: ${suite.tests.length} total (${counts.passed} passed, ${counts.failed} failed, ${counts.cancelled} cancelled${counts.other > 0 ? `, ${counts.other} other` : ''})`);
  } else if (Array.isArray(suite.runs)) {
    lines.push(`runs: ${suite.runs.length}`);
  }
  return lines;
}

async function pollUntil(
  ctx: CommandContext,
  label: string,
  getStatus: () => Promise<{ status: string }>,
  timeoutMs: number,
  intervalMs: number,
): Promise<string> {
  const deadline = timeoutMs === 0 ? Number.POSITIVE_INFINITY : ctx.now() + timeoutMs;
  for (;;) {
    const current = await getStatus();
    if (TERMINAL_RUN.has(current.status)) return current.status;
    if (ctx.now() >= deadline) {
      throw new PollTimeoutError(`${label} did not settle within ${timeoutMs}ms`);
    }
    await ctx.sleep(intervalMs);
  }
}

export class PollTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PollTimeoutError';
  }
}

async function cmdRun(cmd: Extract<ParsedCommand, { name: 'run' }>, ctx: CommandContext): Promise<number> {
  const client = new StudioClient(cmd.api, cmd.token, ctx.fetchFn);
  let run: RunJson;
  try {
    run = await client.createTestRun(cmd.testId, {
      environmentId: cmd.envId,
      browser: cmd.browser,
      headed: cmd.headed,
      ...(cmd.datasetId !== undefined ? { datasetId: cmd.datasetId } : {}),
      ...(cmd.rowIndex !== undefined ? { rowIndex: cmd.rowIndex } : {}),
    });
  } catch (err) {
    ctx.err(`run failed to start: ${errorMessage(err)}`);
    return EXIT_FAILED;
  }
  if (!cmd.wait) {
    ctx.out(`run ${run.id} queued (test ${cmd.testId})`);
    ctx.out(`poll: studio run --api <url> --token ***** --test ${cmd.testId} --env ${cmd.envId} --wait`);
    return EXIT_PASSED;
  }
  try {
    const status = await pollUntil(
      ctx,
      `run ${run.id}`,
      async () => ({ status: (await client.getRun(run.id)).status }),
      cmd.timeoutMs,
      cmd.intervalMs,
    );
    const final = await client.getRun(run.id);
    for (const line of summarizeRun({ ...final, status })) ctx.out(line);
    return exitCodeForStatus(status);
  } catch (err) {
    if (err instanceof PollTimeoutError) {
      ctx.err(`run ${run.id}: ${err.message}`);
      return EXIT_TIMEOUT;
    }
    ctx.err(`run ${run.id}: poll failed: ${errorMessage(err)}`);
    return EXIT_FAILED;
  }
}

async function cmdSuiteRun(cmd: Extract<ParsedCommand, { name: 'suite-run' }>, ctx: CommandContext): Promise<number> {
  const client = new StudioClient(cmd.api, cmd.token, ctx.fetchFn);
  let suiteRunId: string;
  try {
    const created = await client.createSuiteRun(cmd.suiteId, {
      environmentId: cmd.envId,
      browser: cmd.browser,
      headed: cmd.headed,
      retries: cmd.retries,
      parallel: cmd.parallel,
    });
    suiteRunId = created.suiteRunId;
  } catch (err) {
    ctx.err(`suite-run failed to start: ${errorMessage(err)}`);
    return EXIT_FAILED;
  }
  if (!suiteRunId) {
    ctx.err('suite-run failed to start: server returned no suiteRunId');
    return EXIT_FAILED;
  }
  if (!cmd.wait) {
    ctx.out(`suite-run ${suiteRunId} queued (suite ${cmd.suiteId})`);
    return EXIT_PASSED;
  }
  try {
    const status = await pollUntil(
      ctx,
      `suite-run ${suiteRunId}`,
      async () => ({ status: (await client.getSuiteRun(suiteRunId)).status }),
      cmd.timeoutMs,
      cmd.intervalMs,
    );
    const final = await client.getSuiteRun(suiteRunId);
    for (const line of summarizeSuiteRun({ ...final, status })) ctx.out(line);
    return exitCodeForStatus(status);
  } catch (err) {
    if (err instanceof PollTimeoutError) {
      ctx.err(`suite-run ${suiteRunId}: ${err.message}`);
      return EXIT_TIMEOUT;
    }
    ctx.err(`suite-run ${suiteRunId}: poll failed: ${errorMessage(err)}`);
    return EXIT_FAILED;
  }
}

async function cmdExport(cmd: Extract<ParsedCommand, { name: 'export' }>, ctx: CommandContext): Promise<number> {
  const client = new StudioClient(cmd.api, cmd.token, ctx.fetchFn);
  try {
    let content: string;
    let label: string;
    if (cmd.target.kind === 'test') {
      content = await client.exportSpec(cmd.target.testId, cmd.datasetId);
      label = `test ${cmd.target.testId} (${cmd.format})`;
    } else if (cmd.target.kind === 'run') {
      content = await client.exportRunJUnit(cmd.target.runId);
      label = `run ${cmd.target.runId} (${cmd.format})`;
    } else {
      content = await client.exportSuiteRunJUnit(cmd.target.suiteRunId);
      label = `suite-run ${cmd.target.suiteRunId} (${cmd.format})`;
    }
    await ctx.writeFile(cmd.out, content);
    ctx.out(`exported ${label} -> ${cmd.out} (${Buffer.byteLength(content, 'utf8')} bytes)`);
    return EXIT_PASSED;
  } catch (err) {
    ctx.err(`export failed: ${errorMessage(err)}`);
    return EXIT_FAILED;
  }
}

async function cmdTriggerSchedules(
  cmd: Extract<ParsedCommand, { name: 'trigger-schedules' }>,
  ctx: CommandContext,
): Promise<number> {
  try {
    if (cmd.databaseUrl) ctx.setEnv('DATABASE_URL', cmd.databaseUrl);
    const mod = await ctx.loadServerScheduler(cmd.serverDist);
    const report = await mod.runDueSchedulesOnce(new Date());
    ctx.out(
      `trigger-schedules --once: checked=${report.checked} due=${report.due} ` +
        `fired=${report.fired} skipped=${report.skipped} failed=${report.failed}`,
    );
    return report.failed > 0 ? EXIT_FAILED : EXIT_PASSED;
  } catch (err) {
    ctx.err(`trigger-schedules failed: ${errorMessage(err)}`);
    return EXIT_FAILED;
  }
}

/** Execute a parsed command. Never throws UsageError callers must handle. */
export async function executeCommand(cmd: ParsedCommand, ctx: CommandContext): Promise<number> {
  switch (cmd.name) {
    case 'run':
      return cmdRun(cmd, ctx);
    case 'suite-run':
      return cmdSuiteRun(cmd, ctx);
    case 'export':
      return cmdExport(cmd, ctx);
    case 'trigger-schedules':
      return cmdTriggerSchedules(cmd, ctx);
    case 'help':
      ctx.out(helpFor(cmd.topic));
      return EXIT_PASSED;
  }
}

export interface MainDeps {
  env: NodeJS.ProcessEnv;
  fetchFn?: FetchFn;
  out: (msg: string) => void;
  err: (msg: string) => void;
  writeFile: (path: string, content: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  loadServerScheduler: (serverDist?: string) => Promise<ServerSchedulerModule>;
  setEnv: (key: string, value: string) => void;
}

/** argv → exit code. Usage/config errors → 64 (never 0, never confused with run statuses). */
export async function main(argv: string[], deps: MainDeps): Promise<number> {
  let cmd: ParsedCommand;
  try {
    cmd = parseArgs(argv, deps.env);
  } catch (err) {
    if (err instanceof UsageError) {
      deps.err(`Error: ${err.message}`);
      deps.err('');
      deps.err(HELP_TEXT);
      return EXIT_USAGE;
    }
    throw err;
  }
  const ctx: CommandContext = {
    fetchFn: deps.fetchFn,
    out: deps.out,
    err: deps.err,
    writeFile: deps.writeFile,
    sleep: deps.sleep,
    now: deps.now,
    loadServerScheduler: deps.loadServerScheduler,
    setEnv: deps.setEnv,
  };
  try {
    return await executeCommand(cmd, ctx);
  } catch (err) {
    if (err instanceof StudioApiError) {
      deps.err(`Error: ${err.message}`);
      return EXIT_FAILED;
    }
    deps.err(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_FAILED;
  }
}
