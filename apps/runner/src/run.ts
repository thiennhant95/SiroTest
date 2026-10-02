/**
 * P0 runner lifecycle (07-runner/runner-spec.md), 8 steps:
 *  1. Validate test definition.
 *  2. Resolve selected environment/variables.
 *  3. Create isolated temp run directory.
 *  4. Compile spec/config.
 *  5. Execute Playwright with custom reporter.
 *  6. Stream run/step events over WebSocket (via EventPublisher).
 *  7. Persist status/duration/error/artifact metadata.
 *  8. Cleanup temp source while retaining configured artifacts.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { compileConfig, compileSpec } from './compile.js';
import { redactSecrets, resolveEnv } from './env.js';
import { buildEvent, type EventPublisher } from './events.js';
import { now, terminalRunStatusOf, type RunStore } from './persist.js';
import { CancellationToken, killProcessTree, spawnArgs } from './process.js';
import { resolveTestTimeout, resolveTimeouts } from './timeout.js';
import type { ArtifactRecord, RunRequest, RunStatus, StepRecord, StepStatus } from './types.js';
import { validateTestDefinition, ValidationError } from './validate.js';
import { cleanupWorkDir, createRunWorkspace, writeWorkFile, type RunWorkspace } from './workspace.js';

export interface RunDependencies {
  store: RunStore;
  publish: EventPublisher;
  /** absolute path to the built custom reporter (packages/reporter). */
  reporterPath?: string;
  /** e.g. ['npx', ...] prefix — tests inject a stub command. */
  playwrightCommand?: { command: string; baseArgs: string[] };
}

export interface ActiveRun {
  token: CancellationToken;
  child?: ChildProcess;
}

const activeRuns = new Map<string, ActiveRun>();

/**
 * Default Playwright invocation: `node <playwright-cli.js> test ...`.
 * Resolved from this package so it works on Windows (no .cmd shim) and POSIX
 * alike, always with shell:false + argument array (11-security/security.md).
 */
export function defaultPlaywrightCommand(): { command: string; baseArgs: string[] } {
  try {
    // CJS build: resolve from this file (exports map: "./cli" -> "./cli.js";
    // subpath "./cli.js" is NOT exported, so request "./cli").
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cliJs = createRequire(__filename).resolve('@playwright/test/cli');
    return { command: process.execPath, baseArgs: [cliJs, 'test'] };
  } catch {
    return { command: process.platform === 'win32' ? 'npx.cmd' : 'npx', baseArgs: ['playwright', 'test'] };
  }
}

export function getActiveRun(runId: string): ActiveRun | undefined {
  return activeRuns.get(runId);
}

/** Cancel: kill the whole Playwright process tree, mark incomplete steps/run cancelled. */
export async function cancelRun(runId: string, deps: Pick<RunDependencies, 'store' | 'publish'>): Promise<boolean> {
  const active = activeRuns.get(runId);
  if (!active) return false;
  active.token.cancel();
  await killProcessTree(active.child?.pid);
  const at = now();
  const summary = await deps.store.getSummary(runId);
  if (summary) {
    for (const step of summary.steps) {
      if (step.status === 'pending' || step.status === 'running') {
        // Step enum has no 'cancelled': incomplete steps become 'skipped',
        // the run itself carries status 'cancelled' + run.cancelled event.
        await deps.store.updateStep(runId, step.stepId, {
          status: 'skipped',
          finishedAt: at,
          durationMs: step.startedAt ? at - step.startedAt : 0,
          errorMessage: 'Cancelled by user',
        });
      }
    }
    await deps.store.updateRun(runId, { status: 'cancelled', finishedAt: at });
  }
  deps.publish(buildEvent('run.cancelled', runId, { status: 'cancelled' }));
  return true;
}

function defaultReporterPath(): string {
  try {
    // Workspace dependency: @playwright-studio/reporter
    return require.resolve('@playwright-studio/reporter/dist/reporter.js');
  } catch {
    // Fallback when running from source tree without installed workspace link.
    return join(process.cwd(), 'packages', 'reporter', 'dist', 'reporter.js');
  }
}

interface ReporterEventLine {
  event: string;
  stepId?: string;
  status?: StepStatus;
  durationMs?: number;
  error?: string;
}

/** Tail the reporter's JSONL event file and forward to the WS publisher. */
async function tailEvents(
  eventsPath: string,
  runId: string,
  publish: EventPublisher,
  secrets: string[],
  shouldStop: () => boolean,
): Promise<void> {
  let offset = 0;
  const map: Record<string, 'step.started' | 'step.passed' | 'step.failed'> = {
    'step.started': 'step.started',
    'step.passed': 'step.passed',
    'step.failed': 'step.failed',
  };
  while (!shouldStop()) {
    await new Promise((r) => setTimeout(r, 100));
    let content: string;
    try {
      const buf = await readFile(eventsPath, 'utf8');
      content = buf.slice(offset);
      offset = buf.length;
    } catch {
      continue; // reporter has not created the file yet
    }
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as ReporterEventLine;
        const name = map[parsed.event];
        if (!name) continue;
        publish(
          buildEvent(name, runId, {
            stepId: parsed.stepId,
            status: parsed.status,
            durationMs: parsed.durationMs,
            error: parsed.error ? redactSecrets(parsed.error, secrets) : undefined,
          }),
        );
      } catch {
        // ignore malformed line — events are informational
      }
    }
  }
}

async function collectArtifacts(ws: RunWorkspace, runId: string): Promise<ArtifactRecord[]> {
  // Artifact size limits (11-security/security.md): skip files over the cap so
  // a compromised page cannot fill the disk via huge traces/videos.
  const MAX_BYTES = Number(process.env.ARTIFACT_MAX_BYTES ?? 50 * 1024 * 1024);
  const MAX_SCREENSHOTS = Number(process.env.ARTIFACT_MAX_SCREENSHOTS ?? 100);
  const artifacts: ArtifactRecord[] = [];
  const maybe = async (abs: string, rel: string, type: ArtifactRecord['type'], mimeType: string) => {
    try {
      const st = await stat(abs);
      if (st.isFile() && st.size <= MAX_BYTES) {
        artifacts.push({ id: `${runId}-${type}`, runId, type, path: rel, mimeType, sizeBytes: st.size });
      }
    } catch {
      // optional artifact absent — skip
    }
  };
  await maybe(ws.resultPath, `runs/${runId}/result.json`, 'result', 'application/json');
  await maybe(ws.tracePath, `runs/${runId}/trace.zip`, 'trace', 'application/zip');
  await maybe(ws.videoPath, `runs/${runId}/video.webm`, 'video', 'video/webm');
  try {
    const files = await readdir(ws.screenshotsDir);
    for (const file of files.sort().slice(0, MAX_SCREENSHOTS)) {
      // Basename only: screenshotsDir entries can never escape the artifact dir.
      if (file.includes('/') || file.includes('\\') || file.startsWith('.')) continue;
      const abs = join(ws.screenshotsDir, file);
      const st = await stat(abs);
      if (st.isFile() && st.size <= MAX_BYTES) {
        artifacts.push({
          id: `${runId}-screenshot-${file}`,
          runId,
          type: 'screenshot',
          path: `runs/${runId}/screenshots/${file}`,
          mimeType: 'image/png',
          sizeBytes: st.size,
        });
      }
    }
  } catch {
    // no screenshots — fine
  }
  return artifacts;
}

export async function runTest(req: RunRequest, deps: RunDependencies): Promise<{ status: RunStatus; runId: string }> {
  const { store, publish } = deps;
  const runId = req.runId;
  const token = new CancellationToken();
  activeRuns.set(runId, { token });

  const browser = req.browser ?? req.test.browser;
  await store.createRun({
    id: runId,
    projectId: req.projectId,
    testId: req.test.id,
    environmentId: req.environmentId,
    browser,
    status: 'queued',
    trigger: req.trigger ?? 'api',
  });
  publish(buildEvent('run.queued', runId, { status: 'queued' }));

  // ---- Step 1: validate ----
  try {
    validateTestDefinition(req.test);
  } catch (err) {
    const message = err instanceof ValidationError ? err.message : String(err);
    const at = now();
    await store.updateRun(runId, { status: 'failed', finishedAt: at, errorSummary: message });
    publish(buildEvent('run.failed', runId, { status: 'failed', error: message }));
    activeRuns.delete(runId);
    return { status: 'failed', runId };
  }

  // ---- Step 2: resolve env ----
  const { runtimeEnv, secrets, redacted } = resolveEnv({
    test: req.test,
    projectVariables: req.projectVariables,
    environmentVariables: req.environmentVariables,
  });
  void redacted;

  // ---- Step 3: isolated temp dir ----
  const ws = await createRunWorkspace(runId);
  const startedAt = now();
  await store.updateRun(runId, { status: 'running', startedAt });
  publish(buildEvent('run.started', runId, { status: 'running' }));

  // Seed pending steps (disabled -> skipped up front) with inherited timeouts.
  const timeouts = resolveTimeouts(req.test, req.projectDefaultTimeoutMs);
  const timeoutByStep = new Map(timeouts.map((t) => [t.stepId, t]));
  const test = req.test;
  let sortOrder = 0;
  for (const step of test.steps) {
    const record: StepRecord = {
      id: `${runId}:${step.id}`,
      runId,
      stepId: step.id,
      sortOrder: sortOrder++,
      status: step.enabled ? 'pending' : 'skipped',
      timeoutMs: timeoutByStep.get(step.id)?.timeoutMs ?? 0,
      ...(step.enabled ? {} : { finishedAt: startedAt, durationMs: 0 }),
    };
    await store.upsertStep(record);
  }

  let status: RunStatus = 'failed';
  let errorSummary: string | undefined;

  try {
    // ---- Step 4: compile ----
    const testTimeoutMs = resolveTestTimeout(test, req.projectDefaultTimeoutMs);
    const reporterPath = deps.reporterPath ?? process.env.REPORTER_PATH ?? defaultReporterPath();
    const eventsPath = join(ws.workDir, 'events.jsonl');
    const specSource = compileSpec(test, { testTimeoutMs });
    const configSource = compileConfig({
      browser,
      headed: req.headed ?? false,
      baseUrl: test.baseUrl,
      viewport: test.viewport,
      reporterPath,
      runId,
      trace: req.artifacts?.trace ?? 'retain-on-failure',
      screenshot: req.artifacts?.screenshot ?? 'only-on-failure',
      video: req.artifacts?.video ?? 'retain-on-failure',
      outputDir: join(ws.workDir, 'output'),
    });
    await writeWorkFile(ws.workDir, 'run.spec.ts', specSource);
    await writeWorkFile(ws.workDir, 'playwright.config.ts', configSource);

    // ---- Step 5: execute Playwright (arg array, never a shell string) ----
    // Run the Playwright CLI JS directly under node: `npx` is a .cmd shim on
    // Windows and cannot spawn with shell:false (ENOENT/EINVAL). Still no shell.
    const cli = deps.playwrightCommand ?? defaultPlaywrightCommand();
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...runtimeEnv,
      RUN_ID: runId,
      RUN_ARTIFACT_DIR: ws.artifactDir,
      RUN_EVENTS_PATH: eventsPath,
      RUN_SECRETS_JSON: JSON.stringify(secrets),
      RUN_STEPS_META_JSON: JSON.stringify(
        test.steps.map((s) => ({
          stepId: s.id,
          name: s.name ?? s.type,
          enabled: s.enabled,
          timeoutMs: timeoutByStep.get(s.id)?.timeoutMs,
          timeoutSource: timeoutByStep.get(s.id)?.source,
        })),
      ),
      ...(test.baseUrl ? { RUN_BASE_URL: test.baseUrl } : {}),
    };
    const args = [...cli.baseArgs, `--config=${ws.configPath}`];
    const { child, done } = spawnArgs(cli.command, args, {
      cwd: ws.workDir,
      env: childEnv,
      onOutput: (stream, line) => {
        void stream;
        void redactSecrets(line, secrets); // hook for log sink; never persist raw secrets
      },
    });
    activeRuns.get(runId)!.child = child;

    // ---- Step 6: stream WS events (tail reporter JSONL) ----
    let childSettled = false;
    const tailPromise = tailEvents(eventsPath, runId, publish, secrets, () => childSettled);
    const result = await done;
    childSettled = true;
    await tailPromise;

    if (token.cancelled) {
      status = 'cancelled';
      errorSummary = 'Cancelled by user';
    } else if (result.exitCode === 0) {
      status = 'passed';
    } else {
      status = 'failed';
      errorSummary = result.signal ? `Playwright killed by signal ${result.signal}` : `Playwright exited with code ${result.exitCode}`;
    }

    // ---- Step 7: persist (reporter wrote result.json; adopt it) ----
    try {
      const raw = await readFile(ws.resultPath, 'utf8');
      const parsed = JSON.parse(raw) as {
        status?: RunStatus;
        steps?: Array<{ stepId: string; status: StepStatus; startedAt?: number; finishedAt?: number; durationMs?: number; error?: string; screenshot?: string }>;
        error?: string;
      };
      if (!token.cancelled && (parsed.status === 'passed' || parsed.status === 'failed')) status = parsed.status;
      if (parsed.error) errorSummary = redactSecrets(parsed.error, secrets);
      const at = now();
      if (Array.isArray(parsed.steps)) {
        for (const s of parsed.steps) {
          try {
            await store.updateStep(runId, s.stepId, {
              status: s.status,
              startedAt: s.startedAt,
              finishedAt: s.finishedAt ?? at,
              durationMs: s.durationMs,
              errorMessage: s.error ? redactSecrets(s.error, secrets) : undefined,
              screenshotPath: s.screenshot,
            });
          } catch {
            // step missing from seed (should not happen) — ignore
          }
        }
      }
    } catch {
      // result.json missing/unreadable (e.g. crash before reporter onEnd) — keep exit-code status.
    }

    if (token.cancelled) status = 'cancelled';
    const finishedAt = now();
    const summary = await store.getSummary(runId);
    if (summary) {
      for (const step of summary.steps) {
        if (step.status === 'pending' || step.status === 'running') {
          await store.updateStep(runId, step.stepId, {
            status: status === 'cancelled' ? 'skipped' : 'failed',
            finishedAt,
            durationMs: step.startedAt ? finishedAt - step.startedAt : 0,
            errorMessage: step.errorMessage ?? errorSummary ?? 'Step did not report a result',
          });
        }
      }
    }
    for (const artifact of await collectArtifacts(ws, runId)) {
      await store.addArtifact(artifact);
    }
    await store.updateRun(runId, {
      status,
      finishedAt,
      durationMs: finishedAt - startedAt,
      ...(errorSummary ? { errorSummary: redactSecrets(errorSummary, secrets) } : {}),
    });
    const terminal = terminalRunStatusOf(status === 'failed', status === 'cancelled');
    publish(
      buildEvent(
        terminal === 'passed' ? 'run.passed' : terminal === 'cancelled' ? 'run.cancelled' : 'run.failed',
        runId,
        { status: terminal, ...(errorSummary ? { error: redactSecrets(errorSummary, secrets) } : {}) },
      ),
    );
  } catch (err) {
    const finishedAt = now();
    errorSummary = redactSecrets(err instanceof Error ? err.message : String(err), secrets);
    if (token.cancelled) status = 'cancelled';
    await store.updateRun(runId, { status, finishedAt, durationMs: finishedAt - startedAt, errorSummary });
    publish(buildEvent(status === 'cancelled' ? 'run.cancelled' : 'run.failed', runId, { status, error: errorSummary }));
  } finally {
    // ---- Step 8: cleanup temp source, retain storage/runs/<run-id> ----
    try {
      await cleanupWorkDir(ws.workDir);
    } catch {
      // best effort — temp dirs are also namespaced for external reaping
    }
    activeRuns.delete(runId);
  }

  return { status, runId };
}
