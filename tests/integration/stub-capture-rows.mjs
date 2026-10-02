/**
 * Capture stub for P1 dataset integration tests (no browser required).
 * Behaves like stub-playwright.mjs on the passing path, and additionally
 * writes the raw `VV_DATASET_ROWS` child env to `$VV_CAPTURE_PATH` so tests
 * can assert exactly which rows the runner injected (all rows vs rowIndex).
 *
 * An inline `node -e` command cannot be used here: the runner always appends
 * `--config=<path>` and node's option parser rejects it after `-e`
 * (exit code 9). A real file argument is ignored like any other CLI arg.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const eventsPath = process.env.RUN_EVENTS_PATH;
const artifactDir = process.env.RUN_ARTIFACT_DIR;
const capturePath = process.env.VV_CAPTURE_PATH;
if (!eventsPath || !artifactDir || !capturePath) {
  console.error('stub-capture-rows: missing RUN_EVENTS_PATH / RUN_ARTIFACT_DIR / VV_CAPTURE_PATH');
  process.exit(2);
}

const emit = (obj) => appendFileSync(eventsPath, `${JSON.stringify(obj)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  writeFileSync(capturePath, process.env.VV_DATASET_ROWS ?? 'MISSING');

  /** @type {Array<{stepId: string; enabled?: boolean}>} */
  const steps = JSON.parse(process.env.RUN_STEPS_META_JSON ?? '[]');
  const enabled = steps.filter((s) => s.enabled !== false);
  mkdirSync(join(artifactDir, 'screenshots'), { recursive: true });

  const now = Date.now();
  const resultSteps = [];
  for (const step of enabled) {
    emit({ event: 'step.started', stepId: step.stepId, status: 'running' });
    await sleep(10);
    emit({ event: 'step.passed', stepId: step.stepId, status: 'passed', durationMs: 10 });
    resultSteps.push({ stepId: step.stepId, status: 'passed', startedAt: now, finishedAt: now + 10, durationMs: 10 });
  }

  writeFileSync(join(artifactDir, 'screenshots', 's1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(join(artifactDir, 'trace.zip'), Buffer.from('PK-fake-trace'));
  writeFileSync(join(artifactDir, 'result.json'), JSON.stringify({ status: 'passed', steps: resultSteps }));
  process.exit(0);
}

main();
