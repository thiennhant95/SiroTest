/**
 * Visual stub Playwright CLI for P2 integration tests (no browser required).
 *
 * Unlike stub-playwright.mjs (which only mimics the reporter contract), this
 * stub ALSO executes the REAL isolated-workdir helper
 * (`./vv-visual-compare.cjs`, materialized by the runner in step 4) against
 * REAL baselines from VV_BASELINES — the only simulated part is screenshot
 * capture (synthetic PNG bytes instead of a browser frame).
 *
 * - cwd IS the isolated workdir (spawnArgs cwd), so require() finds the helper.
 * - VV_VISUAL_STEPS: JSON [{ stepId, name, threshold }] (runner injects).
 * - Actual PNGs land in RUN_ARTIFACT_DIR/screenshots/visual-<safe>.png
 *   (mirroring the generated spec); diff PNGs are written by the helper.
 * - flags: --visual-diff (first visual step gets a different-color actual),
 *   --fail (generic failure like the base stub).
 */
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const VISUAL_DIFF = args.includes('--visual-diff');
const FAIL = args.includes('--fail');

const eventsPath = process.env.RUN_EVENTS_PATH;
const artifactDir = process.env.RUN_ARTIFACT_DIR;
if (!eventsPath || !artifactDir) {
  console.error('stub-playwright-visual: missing RUN_EVENTS_PATH / RUN_ARTIFACT_DIR');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (obj) => appendFileSync(eventsPath, `${JSON.stringify(obj)}\n`);

async function main() {
  const helper = require(join(process.cwd(), 'vv-visual-compare.cjs'));
  const steps = JSON.parse(process.env.RUN_STEPS_META_JSON ?? '[]');
  const visualSteps = JSON.parse(process.env.VV_VISUAL_STEPS ?? '[]');
  const visualById = new Map(visualSteps.map((v) => [v.stepId, v]));
  const baselines = JSON.parse(process.env.VV_BASELINES ?? '{}');
  const enabled = steps.filter((s) => s.enabled !== false);
  mkdirSync(join(artifactDir, 'screenshots'), { recursive: true });

  const now = Date.now();
  const resultSteps = [];
  let failed = false;

  for (const step of enabled) {
    emit({ event: 'step.started', stepId: step.stepId, status: 'running' });
    await sleep(10);
    const visual = visualById.get(step.stepId);
    if (!visual) {
      if (FAIL && resultSteps.length === 0) {
        const error = 'generic stub failure';
        emit({ event: 'step.failed', stepId: step.stepId, status: 'failed', durationMs: 11, error });
        resultSteps.push({ stepId: step.stepId, status: 'failed', startedAt: now, finishedAt: now + 11, durationMs: 11, error });
        failed = true;
        break;
      }
      emit({ event: 'step.passed', stepId: step.stepId, status: 'passed', durationMs: 10 });
      resultSteps.push({ stepId: step.stepId, status: 'passed', startedAt: now, finishedAt: now + 10, durationMs: 10 });
      continue;
    }
    // Visual step: synthesize the actual screenshot, then run the REAL helper.
    const fileName = helper.vvSanitizeVisualFileName(visual.name);
    const actualPath = join(artifactDir, 'screenshots', fileName);
    const baselinePath = baselines[visual.name];
    if (VISUAL_DIFF && !main.diffUsed) {
      main.diffUsed = true;
      // Same dimensions, different color -> genuine over-threshold diff.
      const base = helper.vvDecodePng(readFileSync(baselinePath));
      const rgba = Buffer.alloc(base.width * base.height * 4);
      for (let i = 0; i < base.width * base.height; i++) {
        rgba[i * 4] = 255 - base.data[i * 4];
        rgba[i * 4 + 1] = 255 - base.data[i * 4 + 1];
        rgba[i * 4 + 2] = 255 - base.data[i * 4 + 2];
        rgba[i * 4 + 3] = 255;
      }
      writeFileSync(actualPath, helper.vvEncodePng(base.width, base.height, rgba));
    } else if (baselinePath && existsSync(baselinePath) && process.env.VV_UPDATE_BASELINES !== '1') {
      copyFileSync(baselinePath, actualPath); // identical -> pass
    } else {
      // No baseline (first capture / missing): gray placeholder; the helper
      // decides (update mode passes, otherwise VISUAL_BASELINE_MISSING).
      const rgba = Buffer.alloc(8 * 8 * 4).fill(128);
      for (let i = 0; i < 8 * 8; i++) rgba[i * 4 + 3] = 255;
      writeFileSync(actualPath, helper.vvEncodePng(8, 8, rgba));
    }
    try {
      helper.compareVisualFromEnv({ name: visual.name, actualPath, threshold: visual.threshold });
      emit({ event: 'step.passed', stepId: step.stepId, status: 'passed', durationMs: 10 });
      resultSteps.push({ stepId: step.stepId, status: 'passed', startedAt: now, finishedAt: now + 10, durationMs: 10 });
    } catch (err) {
      const error = err.message;
      emit({ event: 'step.failed', stepId: step.stepId, status: 'failed', durationMs: 11, error });
      resultSteps.push({ stepId: step.stepId, status: 'failed', startedAt: now, finishedAt: now + 11, durationMs: 11, error });
      failed = true;
    }
  }

  writeFileSync(join(artifactDir, 'screenshots', 's1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(join(artifactDir, 'trace.zip'), Buffer.from('PK-fake-trace'));

  const status = failed || FAIL ? 'failed' : 'passed';
  writeFileSync(join(artifactDir, 'result.json'), JSON.stringify({ status, steps: resultSteps }));
  process.exit(status === 'passed' ? 0 : 1);
}

main();
