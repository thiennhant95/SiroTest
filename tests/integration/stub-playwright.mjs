/**
 * Stub Playwright CLI for integration tests (no browser required).
 * Mimics the custom reporter's contract with apps/runner:
 * - appends step.started/step.passed JSONL to RUN_EVENTS_PATH
 * - writes result.json + screenshots/*.png + trace.zip into RUN_ARTIFACT_DIR
 * - flags: --fail (exit 1, failed result leaking a secret into the error),
 *          --slow <ms> (pause mid-run so cancelRun can interrupt),
 *          --no-result (exit 0 without result.json, i.e. reporter crash).
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const FAIL = args.includes('--fail');
const NO_RESULT = args.includes('--no-result');
const slowIdx = args.indexOf('--slow');
const SLOW_MS = slowIdx === -1 ? 0 : Number(args[slowIdx + 1] ?? 0);

const eventsPath = process.env.RUN_EVENTS_PATH;
const artifactDir = process.env.RUN_ARTIFACT_DIR;
if (!eventsPath || !artifactDir) {
  console.error('stub-playwright: missing RUN_EVENTS_PATH / RUN_ARTIFACT_DIR');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (obj) => appendFileSync(eventsPath, `${JSON.stringify(obj)}\n`);

async function main() {
  /** @type {Array<{stepId: string; enabled?: boolean}>} */
  const steps = JSON.parse(process.env.RUN_STEPS_META_JSON ?? '[]');
  const enabled = steps.filter((s) => s.enabled !== false);
  mkdirSync(join(artifactDir, 'screenshots'), { recursive: true });

  const now = Date.now();
  /** @type {Array<Record<string, unknown>>} */
  const resultSteps = [];

  for (let i = 0; i < enabled.length; i++) {
    const step = enabled[i];
    emit({ event: 'step.started', stepId: step.stepId, status: 'running' });
    if (SLOW_MS > 0 && i === 0) await sleep(SLOW_MS);
    else await sleep(30);
    if (FAIL && i === 0) {
      const secret = process.env.FIXTURE_PASSWORD ?? '';
      const error = `waiting for selector failed: leaked secret was ${secret}`;
      emit({ event: 'step.failed', stepId: step.stepId, status: 'failed', durationMs: 31, error });
      resultSteps.push({ stepId: step.stepId, status: 'failed', startedAt: now, finishedAt: now + 31, durationMs: 31, error });
      for (const rest of enabled.slice(1)) {
        resultSteps.push({ stepId: rest.stepId, status: 'failed', startedAt: now, finishedAt: now + 1, durationMs: 1, error: 'previous step failed' });
      }
      break;
    }
    emit({ event: 'step.passed', stepId: step.stepId, status: 'passed', durationMs: 30 });
    resultSteps.push({ stepId: step.stepId, status: 'passed', startedAt: now, finishedAt: now + 30, durationMs: 30 });
  }

  // Screenshot + trace artifacts (dummy bytes; the runner only stats them).
  writeFileSync(join(artifactDir, 'screenshots', 's1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(join(artifactDir, 'trace.zip'), Buffer.from('PK-fake-trace'));

  if (!NO_RESULT) {
    const status = FAIL ? 'failed' : 'passed';
    const secret = process.env.FIXTURE_PASSWORD ?? '';
    writeFileSync(
      join(artifactDir, 'result.json'),
      JSON.stringify({
        status,
        steps: resultSteps,
        ...(FAIL ? { error: `run failed, secret in log: ${secret}` } : {}),
      }),
    );
  }
  process.exit(FAIL ? 1 : 0);
}

main();
