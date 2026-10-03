/**
 * Manual argv parsing for the Studio CI CLI (no `commander` — kept light).
 *
 * Pure functions over `(argv, env)` — fully unit-tested, no I/O, and the
 * token is never written anywhere (parsed callers must not log it).
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type Browser = 'chromium' | 'firefox' | 'webkit';
export type ExportFormat = 'spec' | 'junit';

export interface WaitOptions {
  wait: boolean;
  timeoutMs: number;
  intervalMs: number;
}

export interface BaseOptions {
  api: string;
  token: string;
}

export type ParsedCommand =
  | { name: 'run'; api: string; token: string; testId: string; envId: string; browser: Browser; headed: boolean; datasetId?: string; rowIndex?: number } & WaitOptions
  | { name: 'suite-run'; api: string; token: string; suiteId: string; envId: string; browser: Browser; headed: boolean; retries: number; parallel: number } & WaitOptions
  | { name: 'export'; api: string; token: string; target: { kind: 'test'; testId: string } | { kind: 'run'; runId: string } | { kind: 'suite-run'; suiteRunId: string }; format: ExportFormat; out: string; datasetId?: string }
  | { name: 'trigger-schedules'; once: true; databaseUrl?: string; serverDist?: string }
  | { name: 'help'; topic?: string };

/** Exit codes (also printed by `--help` and docs/ci-trigger.md). */
export const EXIT_PASSED = 0;
export const EXIT_FAILED = 1;
export const EXIT_CANCELLED = 2;
export const EXIT_TIMEOUT = 3;
export const EXIT_USAGE = 64;

const BROWSERS: Browser[] = ['chromium', 'firefox', 'webkit'];
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_INTERVAL_MS = 2_000;

interface RawFlags {
  values: Map<string, string | boolean>;
  unknown: string[];
}

const FLAG_ALIASES: Record<string, string> = { '-o': '--out', '-h': '--help' };

/** Flags the parser accepts globally (per-command validators reject misuse). */
const KNOWN_FLAGS = new Set([
  '--api', '--token', '--test', '--env', '--suite', '--run', '--suite-run',
  '--browser', '--headed', '--dataset', '--row', '--retries', '--parallel',
  '--wait', '--timeout-ms', '--interval-ms', '--format', '--out',
  '--once', '--database-url', '--server-dist', '--help',
]);

const BOOLEAN_FLAGS = new Set(['--headed', '--wait', '--once', '--help']);

function rawParse(argv: string[]): RawFlags {
  const values = new Map<string, string | boolean>();
  const unknown: string[] = [];
  let i = 0;
  while (i < argv.length) {
    let token = argv[i]!;
    if (token.startsWith('-') && !token.startsWith('--')) {
      const aliased = FLAG_ALIASES[token];
      if (!aliased) {
        unknown.push(token);
        i += 1;
        continue;
      }
      token = aliased;
    }
    if (!token.startsWith('--')) {
      unknown.push(token);
      i += 1;
      continue;
    }
    const eq = token.indexOf('=');
    const key = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    if (!KNOWN_FLAGS.has(key)) {
      unknown.push(key);
      i += 1;
      continue;
    }
    if (BOOLEAN_FLAGS.has(key)) {
      if (inline !== undefined) {
        if (inline === 'true' || inline === '1' || inline === '') values.set(key, true);
        else if (inline === 'false' || inline === '0') values.set(key, false);
        else throw new UsageError(`${key} expects true/false, got '${inline}'`);
      } else {
        values.set(key, true);
      }
      i += 1;
      continue;
    }
    const value = inline !== undefined ? inline : argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${key} requires a value`);
    }
    values.set(key, value);
    i += inline !== undefined ? 1 : 2;
  }
  return { values, unknown };
}

function str(flags: Map<string, string | boolean>, key: string): string | undefined {
  const v = flags.get(key);
  if (v === undefined || typeof v === 'boolean') return undefined;
  return v;
}

function bool(flags: Map<string, string | boolean>, key: string, def = false): boolean {
  const v = flags.get(key);
  return typeof v === 'boolean' ? v : def;
}

function intIn(flag: string, raw: string | undefined, opts: { min: number; max?: number; def: number }): number {
  if (raw === undefined) return opts.def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < opts.min || (opts.max !== undefined && n > opts.max)) {
    const range = opts.max === undefined ? `>= ${opts.min}` : `${opts.min}..${opts.max}`;
    throw new UsageError(`${flag} must be an integer ${range}, got '${raw}'`);
  }
  return n;
}

function resolveApiToken(flags: Map<string, string | boolean>, env: NodeJS.ProcessEnv): BaseOptions {
  const apiRaw = str(flags, '--api') ?? env['STUDIO_API_URL'] ?? '';
  const api = apiRaw.replace(/\/+$/, '');
  if (!api) throw new UsageError('Missing --api <url> (or STUDIO_API_URL)');
  if (!/^https?:\/\//.test(api)) throw new UsageError(`--api must be an http(s) URL, got '${apiRaw}'`);
  const token = str(flags, '--token') ?? env['STUDIO_TOKEN'] ?? '';
  if (!token) throw new UsageError('Missing --token <token> (or STUDIO_TOKEN)');
  return { api, token };
}

function waitOpts(flags: Map<string, string | boolean>): WaitOptions {
  return {
    wait: bool(flags, '--wait'),
    timeoutMs: intIn('--timeout-ms', str(flags, '--timeout-ms'), { min: 0, def: DEFAULT_TIMEOUT_MS }),
    intervalMs: intIn('--interval-ms', str(flags, '--interval-ms'), { min: 100, def: DEFAULT_INTERVAL_MS }),
  };
}

function browserOpt(flags: Map<string, string | boolean>): Browser {
  const raw = str(flags, '--browser') ?? 'chromium';
  if (!BROWSERS.includes(raw as Browser)) {
    throw new UsageError(`--browser must be one of ${BROWSERS.join('|')}, got '${raw}'`);
  }
  return raw as Browser;
}

/**
 * Parse CLI args (argv WITHOUT the node/script prefix).
 * `env` defaults to process.env — injectable so tests never touch it.
 */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedCommand {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    const topic = rest[0] && !rest[0].startsWith('-') ? rest[0] : undefined;
    return { name: 'help', ...(topic ? { topic } : {}) };
  }
  const { values, unknown } = rawParse(rest);
  if (unknown.length > 0) {
    throw new UsageError(`Unknown argument(s): ${unknown.join(', ')} (see \`studio ${command} --help\`)`);
  }
  if (bool(values, '--help')) return { name: 'help', topic: command };

  switch (command) {
    case 'run': {
      const { api, token } = resolveApiToken(values, env);
      const testId = str(values, '--test');
      const envId = str(values, '--env');
      if (!testId) throw new UsageError('studio run requires --test <id>');
      if (!envId) throw new UsageError('studio run requires --env <id>');
      const datasetId = str(values, '--dataset');
      const rowRaw = str(values, '--row');
      const rowIndex = rowRaw === undefined ? undefined : intIn('--row', rowRaw, { min: 0, def: 0 });
      if (rowIndex !== undefined && datasetId === undefined) {
        throw new UsageError('--row requires --dataset (mirrors the server validation)');
      }
      return {
        name: 'run', api, token, testId, envId,
        browser: browserOpt(values), headed: bool(values, '--headed'),
        ...(datasetId !== undefined ? { datasetId } : {}),
        ...(rowIndex !== undefined ? { rowIndex } : {}),
        ...waitOpts(values),
      };
    }
    case 'suite-run': {
      const { api, token } = resolveApiToken(values, env);
      const suiteId = str(values, '--suite');
      const envId = str(values, '--env');
      if (!suiteId) throw new UsageError('studio suite-run requires --suite <id>');
      if (!envId) throw new UsageError('studio suite-run requires --env <id>');
      return {
        name: 'suite-run', api, token, suiteId, envId,
        browser: browserOpt(values), headed: bool(values, '--headed'),
        retries: intIn('--retries', str(values, '--retries'), { min: 0, max: 5, def: 0 }),
        parallel: intIn('--parallel', str(values, '--parallel'), { min: 1, max: 2, def: 2 }),
        ...waitOpts(values),
      };
    }
    case 'export': {
      const { api, token } = resolveApiToken(values, env);
      const testId = str(values, '--test');
      const runId = str(values, '--run');
      const suiteRunId = str(values, '--suite-run');
      const picked = [testId && 'test', runId && 'run', suiteRunId && 'suite-run'].filter(Boolean);
      if (picked.length === 0) throw new UsageError('studio export requires one of --test|--run|--suite-run');
      if (picked.length > 1) throw new UsageError('studio export accepts only one of --test|--run|--suite-run');
      const out = str(values, '--out');
      if (!out) throw new UsageError('studio export requires -o <file>');
      const datasetId = str(values, '--dataset');
      if (datasetId !== undefined && !testId) throw new UsageError('--dataset only applies to --test exports');
      const formatRaw = str(values, '--format');
      const def: ExportFormat = testId ? 'spec' : 'junit';
      const format: ExportFormat = formatRaw === undefined ? def : formatRaw as ExportFormat;
      if (format !== 'spec' && format !== 'junit') {
        throw new UsageError(`--format must be spec|junit, got '${formatRaw}'`);
      }
      if (testId && format !== 'spec') throw new UsageError('--test export only supports --format spec');
      if (!testId && format !== 'junit') throw new UsageError('--run/--suite-run export only supports --format junit');
      return {
        name: 'export', api, token,
        target: testId ? { kind: 'test', testId } : runId ? { kind: 'run', runId } : { kind: 'suite-run', suiteRunId: suiteRunId! },
        format, out,
        ...(datasetId !== undefined ? { datasetId } : {}),
      };
    }
    case 'trigger-schedules': {
      if (!bool(values, '--once')) {
        throw new UsageError('studio trigger-schedules requires --once (single due pass for external cron/CI)');
      }
      // Local-mode command: fires due schedules in-process on the server host
      // (needs the server DB). No --api/--token involved.
      const databaseUrl = str(values, '--database-url') ?? env['DATABASE_URL'] ?? undefined;
      const serverDist = str(values, '--server-dist') ?? env['STUDIO_SERVER_DIST'] ?? undefined;
      return {
        name: 'trigger-schedules', once: true,
        ...(databaseUrl ? { databaseUrl } : {}),
        ...(serverDist ? { serverDist } : {}),
      };
    }
    default:
      throw new UsageError(`Unknown command '${command}' (see \`studio --help\`)`);
  }
}
