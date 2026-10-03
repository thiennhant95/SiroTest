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

import { copyFile, readdir, readFile, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { compileConfig, compileSpec, VISUAL_DEFAULT_THRESHOLD } from './compile.js';
import { collectPluginStepTypes, materializePlugins, type MaterializedPlugins } from './plugin-shim.js';
import { visualHelperSource } from './visual-compare.js';
import { buildDatasetEnvValue, resolveDatasetRows, VV_DATASET_ROWS_ENV } from './datasets.js';
import { redactSecrets, resolveEnv } from './env.js';
import { buildEvent, type EventPublisher, type RunEventName } from './events.js';
import { attemptHealing, STEP_HEALED_EVENT, type HealAttempt, type HealProbe } from './healing.js';
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
  playwrightCommand?: { command: string; baseArgs: string[]; nodePath?: string };
  /**
   * P2 healing probe: live unique-match counter for alternative candidates.
   * Injected by callers with a live page (tests inject a stub). Absent means
   * every alternative is `undefined` (unknown) — attempts are still recorded
   * with `verified: false`, but no winner is declared and no proposal with a
   * `succeededWith` is produced. Never throws into the run (healing.ts
   * guards probe errors).
   */
  healProbe?: HealProbe;
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
 *
 * `nodePath` is the node_modules dir owning the resolved CLI (pnpm always
 * self-links the package there). The isolated TEMP workdir has no
 * node_modules of its own, so without an explicit NODE_PATH the generated
 * spec/config cannot resolve `@playwright/test` except by ambient luck
 * (e.g. a hoisted copy visible through tsx-inherited NODE_PATH). Passing it
 * explicitly makes execution hermetic on fresh checkouts, CI and self-host.
 */
export function defaultPlaywrightCommand(): { command: string; baseArgs: string[]; nodePath?: string } {
  try {
    // CJS build: resolve from this file (exports map: "./cli" -> "./cli.js";
    // subpath "./cli.js" is NOT exported, so request "./cli").
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cliJs = createRequire(__filename).resolve('@playwright/test/cli');
    // .../.pnpm/<pkg>/node_modules/@playwright/test/cli.js -> .../node_modules
    const nodePath = join(cliJs, '..', '..', '..');
    return { command: process.execPath, baseArgs: [cliJs, 'test'], nodePath };
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
        deps.publish(buildEvent('step.skipped', runId, { stepId: step.stepId, status: 'skipped' }));
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

/** Recursively find the first file with the given name/extension under dir. */
async function findFirstFile(dir: string, match: (name: string) => boolean): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      const hit = await findFirstFile(abs, match);
      if (hit) return hit;
    } else if (e.isFile() && match(e.name)) {
      return abs;
    }
  }
  return null;
}

/** Copy Playwright-produced trace.zip / first .webm from outputDir into the
 *  artifact dir (collectArtifacts picks them up from there). */
async function promotePlaywrightOutputs(ws: RunWorkspace): Promise<void> {
  const outDir = join(ws.workDir, 'output');
  const trace = await findFirstFile(outDir, (n) => n === 'trace.zip');
  if (trace) {
    try {
      await copyFile(trace, ws.tracePath);
    } catch {
      // best effort — collectArtifacts simply records nothing
    }
  }
  const video = await findFirstFile(outDir, (n) => n.toLowerCase().endsWith('.webm'));
  if (video) {
    try {
      await copyFile(video, ws.videoPath);
    } catch {
      // best effort
    }
  }
}

async function collectArtifacts(ws: RunWorkspace, runId: string): Promise<ArtifactRecord[]> {  // Artifact size limits (11-security/security.md): skip files over the cap so
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

export async function runTest(req: RunRequest, deps: RunDependencies): Promise<{ status: RunStatus; runId: string; healing: HealAttempt[] }> {
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
    ...(req.datasetId !== undefined ? { datasetId: req.datasetId } : {}),
    ...(req.rowIndex !== undefined ? { rowIndex: req.rowIndex } : {}),
  });
  publish(buildEvent('run.queued', runId, { status: 'queued' }));

  // ---- Step 1: validate ----
  // Dataset selection is validated here too (unknown datasetId / bad rowIndex
  // fail fast before any workspace/spawn). Resolved rows are injected as
  // VV_DATASET_ROWS in step 5; the compiled spec loops over them (or runs
  // once with `{}` when the dataset is empty — never silently skipped).
  let datasetRows: Record<string, string>[] = [];
  try {
    validateTestDefinition(req.test);
    datasetRows = resolveDatasetRows(req.test, req.datasetId, req.rowIndex);
    // P1 wave-2 run inputs fail fast (before any workspace/spawn).
    if (req.filePaths !== undefined) {
      if (!req.filePaths || typeof req.filePaths !== 'object' || Array.isArray(req.filePaths)) {
        throw new ValidationError([
          { code: 'FILE_PATHS_INVALID', message: 'filePaths must be a record of fileId -> absolute path' },
        ]);
      }
      for (const [k, v] of Object.entries(req.filePaths)) {
        if (typeof v !== 'string' || v.length === 0) {
          throw new ValidationError([
            { code: 'FILE_PATHS_INVALID', message: `filePaths['${k}'] must be a non-empty absolute path` },
          ]);
        }
      }
    }
    if (req.storageStateJson !== undefined) {
      if (typeof req.storageStateJson !== 'string' || req.storageStateJson.length === 0) {
        throw new ValidationError([
          { code: 'STORAGE_STATE_INVALID', message: 'storageStateJson must be a non-empty JSON string' },
        ]);
      }
      try {
        JSON.parse(req.storageStateJson);
      } catch {
        throw new ValidationError([
          { code: 'STORAGE_STATE_INVALID', message: 'storageStateJson must be valid JSON' },
        ]);
      }
    }
  } catch (err) {
    // Name fallback: under tsx dev/loader conditions validate.js can exist
    // as dual ESM/CJS instances (see datasets.ts re-export note) — the
    // message stays identical either way, never silently swallowed.
    const message =
      err instanceof ValidationError || (err as Error)?.name === 'ValidationError'
        ? (err as Error).message
        : String(err);
    const at = now();
    await store.updateRun(runId, { status: 'failed', finishedAt: at, errorSummary: message });
    publish(buildEvent('run.failed', runId, { status: 'failed', error: message }));
    activeRuns.delete(runId);
    return { status: 'failed', runId, healing: [] };
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
  // P2 healing outcomes (proposal-only; the steps below stay `failed`).
  // Prisma `RunStep` has no evidence column (schema frozen) — evidence
  // travels via the `step.healed` WS event + this return value so the server
  // can persist `HealingProposal` rows. Never silently applied.
  const healing: HealAttempt[] = [];

  try {
    // ---- Step 4: compile ----
    const testTimeoutMs = resolveTestTimeout(test, req.projectDefaultTimeoutMs);
    const reporterPath = deps.reporterPath ?? process.env.REPORTER_PATH ?? defaultReporterPath();
    const eventsPath = join(ws.workDir, 'events.jsonl');
    // P1 auth context: materialize the decrypted storageState JSON as
    // `storageState.json` in the isolated workDir (config points at the
    // relative filename; step 8 removes the whole workDir). Validated as
    // JSON in step 1 — written verbatim here, never logged.
    let storageStateFile: string | undefined;
    if (req.storageStateJson !== undefined) {
      await writeWorkFile(ws.workDir, 'storageState.json', req.storageStateJson);
      storageStateFile = 'storageState.json';
    }
    // P2 visual regression: materialize the self-contained compare helper
    // so generated specs can screenshot + diff without new dependencies.
    const visualSteps = test.steps.filter((s) => s.enabled !== false && s.type === 'visualCheck');
    if (visualSteps.length > 0) {
      await writeWorkFile(ws.workDir, 'vv-visual-compare.cjs', visualHelperSource());
    }
    // P2 plugins: load the trusted registry (ALLOW_PLUGINS=1 required),
    // copy entry files into the workdir and write the `vv-plugins.cjs`
    // shim. Disabled/missing plugins fail here with an explicit
    // PLUGIN_* error — before any browser is spawned, never silently.
    const pluginTypes = collectPluginStepTypes(test.steps);
    let pluginRegistry: MaterializedPlugins['registry'] | undefined;
    if (pluginTypes.length > 0) {
      pluginRegistry = (await materializePlugins(ws.workDir, pluginTypes, req.pluginsDir)).registry;
    }
    const specSource = compileSpec(test, {
      testTimeoutMs,
      datasetId: req.datasetId,
      // P1 reusable actions: resolved callee bodies (server loads them from
      // the project's actions table). Absent actions fail explicitly inside
      // compileSpec — before any browser is spawned, never silently skipped.
      ...(req.actions !== undefined
        ? { actions: new Map(req.actions.map((a) => [a.id, a] as const)) }
        : {}),
      // P2 plugins: trusted registry materialized into the workdir above;
      // passing the snapshot makes unknown types / bad secret literals fail
      // here instead of inside the worker (same explicit codes either way).
      ...(pluginRegistry !== undefined ? { plugins: pluginRegistry } : {}),
    });
    const configSource = compileConfig({
      browser,
      headed: req.debug === true ? true : (req.headed ?? false),
      ...(req.slowMoMs ? { slowMoMs: req.slowMoMs } : {}),
      baseUrl: test.baseUrl,
      viewport: test.viewport,
      reporterPath,
      runId,
      trace: req.artifacts?.trace ?? 'retain-on-failure',
      screenshot: req.artifacts?.screenshot ?? 'only-on-failure',
      video: req.artifacts?.video ?? 'retain-on-failure',
      outputDir: join(ws.workDir, 'output'),
      // P1 auth context: materialized per run, removed with the workDir in
      // step 8. Undefined keeps the P0 fresh-context default.
      ...(storageStateFile !== undefined ? { storageStateFile } : {}),
    });
    await writeWorkFile(ws.workDir, 'run.spec.ts', specSource);
    await writeWorkFile(ws.workDir, 'playwright.config.ts', configSource);

    // ---- Step 5: execute Playwright (arg array, never a shell string) ----
    // Run the Playwright CLI JS directly under node: `npx` is a .cmd shim on
    // Windows and cannot spawn with shell:false (ENOENT/EINVAL). Still no shell.
    const cli = deps.playwrightCommand ?? defaultPlaywrightCommand();
    // Hermetic module resolution for the isolated TEMP workdir: it has no
    // node_modules of its own, so the child gets an explicit NODE_PATH to the
    // modules owning the resolved CLI (prepended; ambient entries preserved).
    const nodePath = cli.nodePath
      ? cli.nodePath + delimiter + (process.env.NODE_PATH ?? '')
      : process.env.NODE_PATH;
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...runtimeEnv,
      ...(nodePath ? { NODE_PATH: nodePath } : {}),
      RUN_ID: runId,
      RUN_ARTIFACT_DIR: ws.artifactDir,
      // Debug mode (≈ --debug): PWDEBUG=1 makes Playwright open its
      // Inspector on this host; headed is forced above. The run stays alive
      // until the tester closes the browser/Inspector or hits Cancel.
      ...(req.debug === true ? { PWDEBUG: '1' } : {}),
      RUN_EVENTS_PATH: eventsPath,
      RUN_SECRETS_JSON: JSON.stringify(secrets),
      // P1 data-driven: selected rows (or all rows) as JSON. Present only
      // when a dataset was selected; the spec loop falls back to one empty
      // row when the array is empty. Size-capped in datasets.ts (fail fast).
      ...(req.datasetId !== undefined
        ? { [VV_DATASET_ROWS_ENV]: buildDatasetEnvValue(datasetRows) }
        : {}),
      // P1 wave-2 files: fileId -> absolute path map for `upload` steps.
      // Injected under both the namespaced and legacy keys (the spec
      // prefers VV_FILE_PATHS, falls back to FILE_PATHS).
      ...(req.filePaths !== undefined
        ? { VV_FILE_PATHS: JSON.stringify(req.filePaths), FILE_PATHS: JSON.stringify(req.filePaths) }
        : {}),
      // P2 visual regression: baseline name -> absolute path map for
      // `visualCheck` steps (server resolves from the Baseline table) plus
      // the capture flag. The stub runner and generated specs read these.
      VV_BASELINES: JSON.stringify(req.baselines ?? {}),
      ...(req.updateBaselines === true ? { VV_UPDATE_BASELINES: '1' } : {}),
      ...(visualSteps.length > 0
        ? {
            VV_VISUAL_STEPS: JSON.stringify(
              visualSteps.map((s) => ({
                stepId: s.id,
                name: typeof (s as { name?: unknown }).name === 'string' ? (s as { name?: unknown }).name : s.id,
                threshold:
                  typeof (s as { threshold?: unknown }).threshold === 'number'
                    ? (s as { threshold?: number }).threshold
                    : VISUAL_DEFAULT_THRESHOLD,
              })),
            ),
          }
        : {}),
      // P2 plugins: type -> { file, schema } for the `vv-plugins.cjs` shim.
      ...(pluginRegistry !== undefined ? { VV_PLUGINS: JSON.stringify(pluginRegistry) } : {}),
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
    // ---- Step 7b: P2 opt-in healing analysis (proposal-only) ----
    // Runs only when `healWithAlternatives === true` (default false keeps P0
    // behavior byte-identical: no extra events, empty `healing`). For every
    // FAILED locator-bearing step whose error is a locator failure and whose
    // definition carries stored alternatives, walk the alternatives in order
    // (healing.ts). The step keeps `failed`; a `step.healed` event carries
    // runId + stepId + evidence (informational, like all WS events), and the
    // attempt is collected below for the server to persist as a reviewable
    // `HealingProposal` (pending). Nothing is rewritten here — the runner
    // has no DB and never mutates the stored definition.
    if (req.healWithAlternatives === true && !token.cancelled) {
      const settled = await store.getSummary(runId);
      if (settled) {
        const defById = new Map(test.steps.map((s) => [s.id, s]));
        for (const rec of settled.steps) {
          if (rec.status !== 'failed') continue;
          const defStep = defById.get(rec.stepId);
          if (!defStep) continue;
          const attempt = attemptHealing(defStep, rec.errorMessage ?? '', deps.healProbe);
          if (!attempt) continue;
          healing.push(attempt);
          publish(
            buildEvent(STEP_HEALED_EVENT, runId, {
              stepId: attempt.stepId,
              status: 'failed',
              evidence: { fromLocator: attempt.fromLocator, ...attempt.evidence },
            }),
          );
        }
      }
    }
    // Playwright writes trace.zip / *.webm under outputDir (workDir/output),
    // never directly to the artifact dir — promote the first of each into
    // storage before cleanup, otherwise trace/video artifacts can never
    // exist no matter the retention mode. Best-effort: absence just means
    // Playwright produced none (e.g. mode 'off').
    await promotePlaywrightOutputs(ws);
    for (const artifact of await collectArtifacts(ws, runId)) {
      await store.addArtifact(artifact);
    }    await store.updateRun(runId, {
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

  return { status, runId, healing };
}
