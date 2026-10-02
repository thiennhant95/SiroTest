/**
 * @playwright-studio/reporter — P0 custom Playwright reporter + result.json schema.
 *
 * Wired into an isolated run via the generated playwright.config.ts:
 *   reporter: [[reporterPath, { runId }]]
 * Runtime context (artifact dir, secrets, step metadata) travels over
 * environment variables set by the runner: RUN_ID, RUN_ARTIFACT_DIR,
 * RUN_EVENTS_PATH, RUN_SECRETS_JSON, RUN_STEPS_META_JSON.
 */

export { P0Reporter, parseStepId, type ReporterOptions, type StepMeta } from './reporter.js';
export { redactResult, REDACTED, type RunResultJson, type RunResultStatus, type StepResultEntry } from './result.js';
import { P0Reporter } from './reporter.js';
export default P0Reporter;
