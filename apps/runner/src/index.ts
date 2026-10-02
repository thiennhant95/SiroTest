/**
 * @playwright-studio/runner — P0 isolated Playwright execution.
 *
 * Library usage (API server):
 *   import { runTest, cancelRun, RunQueue, InMemoryRunStore } from '@playwright-studio/runner';
 *   const store = new InMemoryRunStore(); // P0; swap for Prisma store in server
 *   const queue = new RunQueue(2, { onQueued: (runId) => publish({ event: 'run.queued', runId, ... }) });
 *   POST /tests/:id/runs -> queue.submit(runId, () => runTest(req, { store, publish }));
 *   POST /runs/:id/cancel -> cancelRun(runId, { store, publish });
 *
 * CLI smoke test (no server needed):
 *   tsx src/index.ts --test <path-to-test-definition.json> [--env <env-json>]
 */

export type { RunStatus, StepStatus, TestDefinition, TestStep, RunRequest, RunRecord, StepRecord, ArtifactRecord, RunSummary, VariableDef } from './types.js';
export { validateTestDefinition, ValidationError, SUPPORTED_STEP_TYPES } from './validate.js';
export { resolveEnv, redactSecrets, REDACTED } from './env.js';
export { resolveStepTimeout, resolveTimeouts, resolveTestTimeout, DEFAULT_TEST_TIMEOUT_MS, DEFAULT_STEP_TIMEOUT_MS } from './timeout.js';
export { createRunWorkspace, assertSafePath, cleanupWorkDir, storageRoot } from './workspace.js';
export { compileSpec, compileConfig, CompileError, RUNNER_COMPILER_VERSION } from './compile.js';
export { buildEvent, fanout, noopPublisher, type EventPublisher, type RunEvent, type RunEventName } from './events.js';
export { InMemoryRunStore, terminalRunStatusOf, settleIncompleteSteps, type RunStore } from './persist.js';
export { recoverIncompleteRuns, type RecoveryReport } from './recover.js';
export { retentionDaysFromEnv, selectExpiredRuns, type RetentionCandidate, type RetentionDecision } from './retention.js';
export { spawnArgs, killProcessTree, CancellationToken } from './process.js';
export { RunQueue } from './queue.js';
export { runTest, cancelRun, getActiveRun } from './run.js';

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runTest } from './run.js';
import { InMemoryRunStore } from './persist.js';
import { noopPublisher } from './events.js';
import type { TestDefinition } from './types.js';

async function cli(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] !== '--test' || !args[1]) {
    console.log('Usage: tsx src/index.ts --test <test-definition.json> [--env <env-json>]');
    console.log('Runs a P0 isolated run and prints the summary from storage/runs/<run-id>/result.json.');
    return;
  }
  const test = JSON.parse(await readFile(args[1], 'utf8')) as TestDefinition;
  const envIdx = args.indexOf('--env');
  const environmentVariables =
    envIdx !== -1 && args[envIdx + 1]
      ? (JSON.parse(await readFile(args[envIdx + 1], 'utf8')) as { key: string; value: string; isSecret: boolean }[])
      : [];
  const runId = `run_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const store = new InMemoryRunStore();
  const { status } = await runTest(
    { runId, test, projectId: test.projectId, environmentVariables },
    { store, publish: noopPublisher() },
  );
  const summary = await store.getSummary(runId);
  console.log(JSON.stringify({ runId, status, summary }, null, 2));
  if (status !== 'passed') process.exitCode = 1;
}

const invokedDirectly = process.argv[1]?.endsWith('index.ts') ?? false;
if (invokedDirectly) {
  cli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
