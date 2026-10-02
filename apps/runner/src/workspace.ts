/**
 * Step 3/8 + Step 8/8 — Isolated run workspace and artifact layout.
 *
 * Isolation (runner-spec.md + 11-security/security.md):
 * - Every run gets a UNIQUE working directory under os.tmpdir() (fresh browser
 *   context via a per-run storageState file; no shared test state).
 * - Artifacts live separately under storage/runs/<run-id>/ so temp cleanup
 *   never deletes them.
 * - runId is strictly validated and every artifact write goes through
 *   assertSafePath() to block path traversal.
 * - Playwright is always spawned with an argument ARRAY (shell: false) —
 *   see process.ts. Never concatenate user input into shell commands.
 *
 * Layout:
 *   <tmp>/pw-studio-runs/<run-id>/        workDir (generated spec+config, deleted after run)
 *   <storage>/runs/<run-id>/              artifactDir (retained)
 *     result.json
 *     trace.zip
 *     video.webm          (if enabled)
 *     screenshots/
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function assertValidRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid runId '${runId}': must match ${RUN_ID_PATTERN}`);
  }
}

/**
 * Resolve `target` under `base`, throwing on path traversal.
 * Use for EVERY file the runner/reporter writes (spec, config, artifacts).
 */
export function assertSafePath(baseDir: string, targetPath: string): string {
  const base = resolve(baseDir);
  const target = resolve(base, targetPath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`Path traversal blocked: '${targetPath}' escapes '${base}'`);
  }
  return target;
}

export function storageRoot(): string {
  // Repo-relative default; override with STORAGE_ROOT in production/docker.
  return process.env.STORAGE_ROOT ?? join(process.cwd(), 'storage');
}

export interface RunWorkspace {
  runId: string;
  /** isolated temp dir for generated spec/config (removed in step 8) */
  workDir: string;
  /** retained artifact dir: storage/runs/<run-id>/ */
  artifactDir: string;
  screenshotsDir: string;
  specPath: string;
  configPath: string;
  tracePath: string;
  videoPath: string;
  resultPath: string;
}

/** Step 3 — create isolated temp dir + artifact dir skeleton for one run. */
export async function createRunWorkspace(runId: string): Promise<RunWorkspace> {
  assertValidRunId(runId);
  const runsTmp = join(tmpdir(), 'pw-studio-runs');
  await mkdir(runsTmp, { recursive: true });
  const workDir = await mkdtemp(join(runsTmp, `${runId}-`));

  const artifactDir = assertSafePath(join(storageRoot(), 'runs'), runId);
  const screenshotsDir = join(artifactDir, 'screenshots');
  await mkdir(screenshotsDir, { recursive: true });

  return {
    runId,
    workDir,
    artifactDir,
    screenshotsDir,
    specPath: join(workDir, 'run.spec.ts'),
    configPath: join(workDir, 'playwright.config.ts'),
    tracePath: join(artifactDir, 'trace.zip'),
    videoPath: join(artifactDir, 'video.webm'),
    resultPath: join(artifactDir, 'result.json'),
  };
}

/** Write a file guaranteed to stay inside the run workDir. */
export async function writeWorkFile(workDir: string, fileName: string, content: string): Promise<string> {
  const full = assertSafePath(workDir, fileName);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
  return full;
}

/** Step 8 — remove the temp source dir; artifacts under storage/ are retained. */
export async function cleanupWorkDir(workDir: string): Promise<void> {
  const base = resolve(join(tmpdir(), 'pw-studio-runs'));
  assertSafePath(base, resolve(workDir));
  await rm(workDir, { recursive: true, force: true });
}
