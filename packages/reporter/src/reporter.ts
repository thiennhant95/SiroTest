/**
 * P0 custom Playwright reporter (@playwright/test `Reporter` interface,
 * typed structurally so the package has no hard runtime dependency).
 *
 * Responsibilities (07-runner/artifacts-reporting.md):
 * - Emit step.started / step.passed / step.failed and run.passed / run.failed
 *   as JSONL to RUN_EVENTS_PATH (the runner tails this file and publishes
 *   to WebSocket). Payloads carry runId; secrets are redacted.
 * - Save result.json to the artifact dir (storage/runs/<run-id>/).
 * - Copy screenshots into screenshots/ and promote trace.zip / video.webm
 *   from the Playwright output dir into the artifact dir.
 *
 * Step mapping: the compiled spec names every test.step `[<stepId>] <name>`,
 * so the reporter recovers the TestDefinition step id by parsing the prefix.
 * Disabled steps never execute; they are marked `skipped` from RUN_STEPS_META_JSON.
 */

import { appendFile, copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { redactResult, type RunResultJson, type RunResultStatus, type StepResultEntry } from './result.js';

// ---- Minimal structural Playwright types (no hard @playwright/test dep) ----
export interface PWTestStep {
  title: string;
  category: string;
  duration: number;
  error?: unknown;
  location?: { file: string; line: number; column: number };
}

export interface PWAttachment {
  name: string;
  path?: string;
  contentType: string;
}

export interface PWTestResult {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  duration: number;
  error?: { message?: string; stack?: string };
  attachments: PWAttachment[];
}

export interface PWTestCase {
  title: string;
  location: { file: string; line: number; column: number };
}

export interface PWFullResult {
  status: 'passed' | 'failed' | 'timedout' | 'interrupted';
}

export interface StepMeta {
  stepId: string;
  name?: string;
  enabled: boolean;
  timeoutMs?: number;
  timeoutSource?: StepResultEntry['timeoutSource'];
}

export interface ReporterOptions {
  runId?: string;
  artifactDir?: string;
  eventsPath?: string;
  secrets?: string[];
  stepsMeta?: StepMeta[];
  compilerVersion?: string;
}

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function parseSecrets(): string[] {
  const raw = readEnv('RUN_SECRETS_JSON');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string' && s.length > 0) : [];
  } catch {
    return [];
  }
}

function parseStepsMeta(): StepMeta[] {
  const raw = readEnv('RUN_STEPS_META_JSON');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StepMeta[]).filter((s) => s && typeof s.stepId === 'string') : [];
  } catch {
    return [];
  }
}

/** Extract `[<stepId>]` prefix compiled into every test.step title. */
export function parseStepId(title: string): string | null {
  const m = /^\[([A-Za-z0-9_-]+)\]\s*/.exec(title);
  return m ? m[1] : null;
}

/**
 * Merge one dataset-loop iteration into the accumulated step entry:
 * durations add up, any failure fails the step, the first error is kept,
 * wall-clock spans earliest-start → latest-finish.
 */
export function mergeIterationEntry(
  prev: StepResultEntry,
  next: StepResultEntry,
): StepResultEntry {
  return {
    stepId: prev.stepId,
    status: prev.status === 'failed' || next.status === 'failed' ? 'failed' : 'passed',
    startedAt: Math.min(prev.startedAt ?? next.startedAt ?? 0, next.startedAt ?? prev.startedAt ?? 0),
    finishedAt: Math.max(prev.finishedAt ?? 0, next.finishedAt ?? 0),
    durationMs: (prev.durationMs ?? 0) + (next.durationMs ?? 0),
    ...(prev.error ?? next.error ? { error: prev.error ?? next.error } : {}),
  };
}

function errorText(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === 'object') {
    const e = error as { message?: unknown; stack?: unknown };
    if (typeof e.stack === 'string') return e.stack;
    if (typeof e.message === 'string') return e.message;
  }
  return String(error);
}

async function findFirstFile(dir: string, predicate: (name: string) => boolean): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of entries.sort()) {
    const abs = join(dir, name);
    let st;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const nested = await findFirstFile(abs, predicate);
      if (nested) return nested;
    } else if (predicate(name)) {
      return abs;
    }
  }
  return null;
}

export class P0Reporter {
  private readonly runId: string;
  private readonly artifactDir: string;
  private readonly screenshotsDir: string;
  private readonly eventsPath?: string;
  private readonly secrets: string[];
  private readonly stepsMeta: StepMeta[];
  private readonly compilerVersion?: string;
  private readonly startedAt = Date.now();
  private readonly live = new Map<string, { startedAt: number; title: string }>();
  private readonly finished = new Map<string, StepResultEntry>();
  private runError?: string;
  private outputDir?: string;

  constructor(options: ReporterOptions = {}) {
    this.runId = options.runId ?? readEnv('RUN_ID') ?? 'run_unknown';
    this.artifactDir = options.artifactDir ?? readEnv('RUN_ARTIFACT_DIR') ?? join(process.cwd(), 'artifacts', this.runId);
    this.screenshotsDir = join(this.artifactDir, 'screenshots');
    this.eventsPath = options.eventsPath ?? readEnv('RUN_EVENTS_PATH');
    this.secrets = options.secrets ?? parseSecrets();
    this.stepsMeta = options.stepsMeta ?? parseStepsMeta();
    this.compilerVersion = options.compilerVersion ?? readEnv('RUN_COMPILER_VERSION');
  }

  // -- Playwright Reporter API (subset used by P0) --

  onBegin?(config: { outputDir: string }): void {
    this.outputDir = config?.outputDir;
  }

  onTestBegin?(): void {
    // run.started is emitted by the runner process; the reporter streams steps + terminal run event.
  }

  onStepBegin?(test: unknown, _result: unknown, step: PWTestStep): void {
    void test;
    void _result;
    if (step.category !== 'test.step') return; // only our test.step() wrappers, not hooks/expect internals
    const stepId = parseStepId(step.title);
    if (!stepId) return;
    this.live.set(stepId, { startedAt: Date.now(), title: step.title });
    void this.emit({ event: 'step.started', stepId, status: 'running' });
  }

  onStepEnd?(test: unknown, _result: unknown, step: PWTestStep): void {
    void test;
    void _result;
    if (step.category !== 'test.step') return;
    const stepId = parseStepId(step.title);
    if (!stepId) return;
    const started = this.live.get(stepId);
    this.live.delete(stepId);
    const finishedAt = Date.now();
    const err = errorText(step.error);
    // Security: redact secrets BEFORE the WS event leaves this process —
    // error text/URLs frequently echo filled values (11-security/security.md).
    const safeErr = err ? this.redact(err) : undefined;
    const entry: StepResultEntry = {
      stepId,
      status: err ? 'failed' : 'passed',
      startedAt: started?.startedAt ?? finishedAt,
      finishedAt,
      durationMs: started ? finishedAt - started.startedAt : step.duration,
      ...(safeErr ? { error: safeErr } : {}),
    };
    // P1 data-driven aggregation: the dataset loop executes the SAME step id
    // once per iteration. Records merge as durationMs = sum(iterations) and
    // status = failed when ANY iteration failed (first error kept), so WS
    // step.* contracts and stepId joins keep working unchanged.
    const prev = this.finished.get(stepId);
    this.finished.set(stepId, prev ? mergeIterationEntry(prev, entry) : entry);
    const merged = this.finished.get(stepId)!;
    void this.emit({
      event: err ? 'step.failed' : 'step.passed',
      stepId,
      status: merged.status,
      durationMs: merged.durationMs,
      ...(merged.error ? { error: merged.error } : {}),
    });
  }

  onTestEnd?(test: PWTestCase, result: PWTestResult): void {
    void test;
    if (result.error) {
      const text = errorText(result.error);
      if (text) this.runError = this.runError ? `${this.runError}\n${text}` : text;
    }
    for (const attachment of result.attachments) {
      if (attachment.contentType.startsWith('image/') && attachment.path) {
        void this.keepScreenshot(attachment);
      }
    }
  }

  onError?(error: unknown): void {
    const text = errorText(error);
    if (text) this.runError = this.runError ? `${this.runError}\n${text}` : text;
  }

  async onEnd?(result: PWFullResult): Promise<void> {
    const failed = result.status !== 'passed' || [...this.finished.values()].some((s) => s.status === 'failed');
    const status: RunResultStatus = failed ? 'failed' : 'passed';
    const finishedAt = Date.now();

    // Attach names/timeout provenance + mark disabled steps skipped.
    const metaById = new Map(this.stepsMeta.map((m) => [m.stepId, m]));
    const steps: StepResultEntry[] = [];
    for (const meta of this.stepsMeta) {
      const live = this.finished.get(meta.stepId);
      if (live) {
        steps.push({ ...live, name: meta.name, timeoutMs: meta.timeoutMs, timeoutSource: meta.timeoutSource });
      } else {
        steps.push({
          stepId: meta.stepId,
          name: meta.name,
          status: meta.enabled ? 'failed' : 'skipped',
          ...(meta.enabled ? { error: this.runError ?? 'Step did not report a result' } : {}),
          timeoutMs: meta.timeoutMs,
          timeoutSource: meta.timeoutSource,
        });
      }
    }
    // Steps the reporter saw but that were absent from meta (defensive).
    for (const [stepId, entry] of this.finished) {
      if (!metaById.has(stepId)) steps.push(entry);
    }

    const screenshots = await this.collectScreenshots(steps);
    const trace = await this.promote('trace.zip', (n) => n === 'trace.zip');
    const video = await this.promote('video.webm', (n) => n.endsWith('.webm'));

    const payload: RunResultJson = redactResult<RunResultJson>(
      {
        schemaVersion: '1.0',
        runId: this.runId,
        status,
        startedAt: this.startedAt,
        finishedAt,
        durationMs: finishedAt - this.startedAt,
        ...(this.runError ? { error: this.runError } : {}),
        steps,
        artifacts: {
          ...(trace ? { trace } : {}),
          ...(video ? { video } : {}),
          screenshots,
        },
        ...(this.compilerVersion ? { compilerVersion: this.compilerVersion } : {}),
      },
      this.secrets,
    );

    await mkdir(this.artifactDir, { recursive: true });
    await writeFile(join(this.artifactDir, 'result.json'), JSON.stringify(payload, null, 2), 'utf8');
    await this.emit({
      event: status === 'passed' ? 'run.passed' : 'run.failed',
      status,
      ...(payload.error ? { error: payload.error } : {}),
    });
  }

  // Playwright requires this when the reporter writes to stdout; we use files.
  printsToStdio?(): boolean {
    return false;
  }

  // -- internals --

  /** Redact known secrets + absolute server paths from client-facing text. */
  private redact(text: string): string {
    let out = text;
    const ordered = [...this.secrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
    for (const s of ordered) out = out.split(s).join('***');
    if (this.artifactDir && out.includes(this.artifactDir)) {
      out = out.split(this.artifactDir).join('[artifacts]');
    }
    if (this.outputDir && out.includes(this.outputDir)) {
      out = out.split(this.outputDir).join('[workdir]');
    }
    return out;
  }

  private async emit(line: Record<string, unknown>): Promise<void> {
    if (!this.eventsPath) return;
    try {
      await appendFile(this.eventsPath, JSON.stringify({ runId: this.runId, at: Date.now(), ...line }) + '\n', 'utf8');
    } catch {
      // events are informational — never fail the run for a sink error
    }
  }

  private async keepScreenshot(attachment: PWAttachment): Promise<void> {
    if (!attachment.path) return;
    try {
      await mkdir(this.screenshotsDir, { recursive: true });
      const dest = join(this.screenshotsDir, basename(attachment.path));
      await copyFile(attachment.path, dest);
      const stepId = [...this.finished.keys()].pop();
      if (stepId) {
        const entry = this.finished.get(stepId)!;
        entry.screenshot = `runs/${this.runId}/screenshots/${basename(dest)}`;
      }
    } catch {
      // best effort
    }
  }

  private async collectScreenshots(steps: StepResultEntry[]): Promise<string[]> {
    const out: string[] = [];
    try {
      const files = await readdir(this.screenshotsDir);
      for (const file of files.sort()) out.push(`runs/${this.runId}/screenshots/${file}`);
    } catch {
      // none yet
    }
    // Backfill screenshot refs onto failed steps lacking one (first-match order).
    let i = 0;
    for (const step of steps) {
      if (step.status === 'failed' && !step.screenshot && i < out.length) step.screenshot = out[i++];
    }
    return out;
  }

  /** Move the first matching file from the Playwright output dir into artifacts. Returns the artifact-relative path. */
  private async promote(fileName: string, predicate: (name: string) => boolean): Promise<string | undefined> {
    if (!this.outputDir) return undefined;
    const found = await findFirstFile(this.outputDir, predicate);
    if (!found) return undefined;
    try {
      await mkdir(this.artifactDir, { recursive: true });
      await copyFile(found, join(this.artifactDir, fileName));
      return `runs/${this.runId}/${fileName}`;
    } catch {
      return undefined;
    }
  }
}

export default P0Reporter;
