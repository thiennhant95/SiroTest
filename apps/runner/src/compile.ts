/**
 * Step 4/8 — Compile TestDefinition -> deterministic Playwright TypeScript.
 *
 * Follows 06-compiler/playwright-compiler.md:
 * - Pure/deterministic for same definition + compiler version.
 * - All generated strings safely escaped (JSON.stringify).
 * - Secret values NEVER inlined: `sensitive` literals must be {{VAR}} refs,
 *   compiled to process.env lookups resolved at run time.
 * - Step names preserved via test.step('[<id>] <name>') for reporter mapping.
 * - Unsupported step type fails compilation with explicit error, never skipped.
 * - Locator mapping: role->getByRole, label->getByLabel,
 *   placeholder->getByPlaceholder, testId->getByTestId, text->getByText,
 *   css/xpath->locator().
 *
 * NOTE: this is the runner-local P0 implementation of the step mapping so an
 * API-triggered run works end-to-end (Day-2 gate). It must converge with
 * packages/playwright-compiler when that package lands; the golden example
 * in examples/generated-login.spec.ts is the shared reference.
 */

import type {
  ActionsContext,
  LocatorCandidate,
  ReusableAction,
  TestDefinition,
  TestStep,
} from './types.js';
import { findTemplateVars } from './env.js';

type CompileDataSet = NonNullable<TestDefinition['datasets']>[number];

export const RUNNER_COMPILER_VERSION = 'p0-runner-1';

export class CompileError extends Error {
  readonly code = 'COMPILE_UNSUPPORTED_STEP';
  readonly stepId?: string;

  constructor(stepId: string | undefined, message: string) {
    super(message);
    this.name = 'CompileError';
    this.stepId = stepId;
  }
}

/** Escape a literal for generated TS source. */
function esc(value: string): string {
  return JSON.stringify(value);
}

/**
 * Compile a `{{VAR}}`/`{{row.COL}}`-templated string to a TS expression reading
 * process.env / the dataset-loop `row` at run time. Pure literals are inlined
 * (escaped). `{{row.*}}` compiles to `(row["COL"] ?? '')` and is only valid
 * inside the dataset loop emitted when `datasetId` is passed to compileSpec.
 */
function templateExpr(template: string, field: string, stepId: string): string {
  const vars = findTemplateVars(template);
  const rows = findRowRefs(template);
  if (vars.length === 0 && rows.length === 0) return esc(template);
  const parts: string[] = [];
  const re = /\{\{\s*(row\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    if (m.index > last) parts.push(esc(template.slice(last, m.index)));
    parts.push(m[1] ? `(row[${esc(m[2])}] ?? '')` : `(process.env[${esc(m[2])}] ?? '')`);
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push(esc(template.slice(last)));
  if (parts.length === 0) {
    throw new CompileError(stepId, `Step '${stepId}': field '${field}' has an empty template`);
  }
  return parts.join(' + ');
}

/** Dataset-row column names referenced as {{row.NAME}} inside a template. */
function findRowRefs(template: string): string[] {
  const names: string[] = [];
  const re = /\{\{\s*row\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) names.push(m[1]);
  return [...new Set(names)];
}

/** Escape literal text for embedding inside a template literal (step titles). */
function escTemplate(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/** A fill value: sensitive literals must be {{VAR}} references (never inlined). */
function secretAwareValueExpr(step: TestStep): string {
  const value = step.value ?? '';
  if (step.sensitive && findTemplateVars(value).length === 0) {
    throw new CompileError(
      step.id,
      `Step '${step.id}': sensitive fill value must be a {{VARIABLE}} reference so the secret is resolved at run time, never inlined`,
    );
  }
  return templateExpr(value, 'value', step.id);
}

function locatorExpr(target: TestStep['target'], stepId: string): string {
  const primary: LocatorCandidate | undefined = target?.primary;
  if (!primary) throw new CompileError(stepId, `Step '${stepId}': missing target.primary`);
  switch (primary.strategy) {
    case 'role': {
      const opts = primary.name !== undefined ? `, { name: ${esc(primary.name)}${primary.exact ? ', exact: true' : ''} }` : '';
      return `page.getByRole(${esc(primary.role)}${opts})`;
    }
    case 'label':
      return `page.getByLabel(${esc(primary.value)}${primary.exact ? ', { exact: true }' : ''})`;
    case 'placeholder':
      return `page.getByPlaceholder(${esc(primary.value)}${primary.exact ? ', { exact: true }' : ''})`;
    case 'testId':
      return `page.getByTestId(${esc(primary.value)})`;
    case 'text':
      return `page.getByText(${esc(primary.value)}${primary.exact ? ', { exact: true }' : ''})`;
    case 'css':
      return `page.locator(${esc(primary.value)})`;
    case 'xpath':
      return `page.locator(${esc(`xpath=${primary.value}`)})`;
    default:
      throw new CompileError(stepId, `Step '${stepId}': unsupported locator strategy '${(primary as { strategy: string }).strategy}'`);
  }
}

function stepBody(step: TestStep): string {
  const loc = () => locatorExpr(step.target, step.id);
  switch (step.type) {
    case 'goto':
      return `await page.goto(${templateExpr(step.url ?? '', 'url', step.id)});`;
    case 'reload':
      return `await page.reload();`;
    case 'goBack':
      return `await page.goBack();`;
    case 'goForward':
      return `await page.goForward();`;
    case 'click':
      return `await ${loc()}.click();`;
    case 'doubleClick':
      return `await ${loc()}.dblclick();`;
    case 'fill':
      return `await ${loc()}.fill(${secretAwareValueExpr(step)});`;
    case 'clear':
      return `await ${loc()}.clear();`;
    case 'press':
      if (!step.key) throw new CompileError(step.id, `Step '${step.id}': press requires key`);
      return step.target ? `await ${loc()}.press(${esc(step.key)});` : `await page.keyboard.press(${esc(step.key)});`;
    case 'check':
      return `await ${loc()}.check();`;
    case 'uncheck':
      return `await ${loc()}.uncheck();`;
    case 'select':
      if (step.value === undefined) throw new CompileError(step.id, `Step '${step.id}': select requires value`);
      return `await ${loc()}.selectOption(${templateExpr(step.value, 'value', step.id)});`;
    case 'hover':
      return `await ${loc()}.hover();`;
    case 'waitForElement': {
      const state = step.state ?? 'visible';
      return `await ${loc()}.waitFor({ state: ${esc(state)} as 'visible' | 'hidden' | 'attached' | 'detached' });`;
    }
    case 'waitForTimeout': {
      const ms = step.milliseconds ?? 0;
      return `await page.waitForTimeout(${Number(ms)}); // WARNING: fixed wait is discouraged`;
    }
    case 'waitForURL':
      return `await page.waitForURL(${templateExpr(step.url ?? step.expected ?? step.pattern ?? '', 'expected', step.id)});`;
    case 'assertVisible':
      return `await expect(${loc()}).toBeVisible();`;
    case 'assertHidden':
      return `await expect(${loc()}).toBeHidden();`;
    case 'assertText':
      return `await expect(${loc()}).toHaveText(${templateExpr(step.expected ?? '', 'expected', step.id)});`;
    case 'assertContainsText':
      return `await expect(${loc()}).toContainText(${templateExpr(step.expected ?? '', 'expected', step.id)});`;
    case 'assertValue':
      return `await expect(${loc()}).toHaveValue(${templateExpr(step.expected ?? '', 'expected', step.id)});`;
    case 'assertURL':
      return `await expect(page).toHaveURL(${templateExpr(step.expected ?? step.pattern ?? '', 'expected', step.id)});`;
    case 'assertTitle':
      return `await expect(page).toHaveTitle(${templateExpr(step.expected ?? '', 'expected', step.id)});`;
    case 'assertEnabled':
      return `await expect(${loc()}).toBeEnabled();`;
    case 'assertDisabled':
      return `await expect(${loc()}).toBeDisabled();`;
    case 'assertChecked':
      return `await expect(${loc()}).toBeChecked();`;
    case 'screenshot':
      return `await page.screenshot({ path: require('node:path').join(__dirname, '..', 'screenshots', ${esc(`${step.id}.png`)}), fullPage: ${step.fullPage ? 'true' : 'false'} });`;
    case 'callAction':
      throw new CompileError(step.id, `Step '${step.id}': callAction needs an actions context — pass { actions } to compileSpec() so the callee body can be inlined explicitly`);
    default:
      throw new CompileError(step.id, `Step '${step.id}': unsupported step type '${step.type}' — failing compilation, never silently skipping`);
  }
}

/**
 * P1 reusable actions (mirror of packages/playwright-compiler inlining,
 * in the runner's own output dialect).
 *
 * A `callAction` step compiles to an outer `test.step('[<callId>] <name>')`
 * wrapping the interpolated callee body. The outer title keeps the `[id]`
 * prefix so the reporter attributes the whole call to the seeded call-step
 * record; inner body titles carry NO `[id]` prefix so they stream as plain
 * nested Playwright steps without creating phantom step records.
 * Unknown actions / missing args / nested calls / plaintext secrets all
 * fail with an explicit CompileError — never silently skipped.
 */
function lookupAction(actions: ActionsContext | undefined, actionId: string): ReusableAction | undefined {
  if (!actions) return undefined;
  if (actions instanceof Map) return actions.get(actionId);
  return Object.prototype.hasOwnProperty.call(actions, actionId)
    ? (actions as Record<string, ReusableAction>)[actionId]
    : undefined;
}

const ACTION_PARAM_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Caller value -> param default -> explicit CompileError when required arg missing. */
function resolveActionArguments(caller: TestStep, action: ReusableAction): Record<string, string> {
  const rawArgs: unknown = (caller as unknown as Record<string, unknown>)['arguments'];
  const callerArgs: Record<string, unknown> =
    rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
  for (const key of Object.keys(callerArgs)) {
    if (!action.parameters.some((p) => p.name === key)) {
      throw new CompileError(caller.id, `Step '${caller.id}': callAction passes unknown argument '${key}' for action '${action.name}' (${action.id})`);
    }
  }
  const resolved: Record<string, string> = {};
  for (const param of action.parameters) {
    const given = callerArgs[param.name];
    if (typeof given === 'string') {
      if (param.secret === true && findTemplateVars(given).length === 0) {
        throw new CompileError(caller.id, `Step '${caller.id}': secret parameter '${param.name}' of action '${action.name}' must be passed as a {{VARIABLE}} reference so the secret is resolved at run time, never inlined`);
      }
      resolved[param.name] = given;
    } else if (given !== undefined) {
      throw new CompileError(caller.id, `Step '${caller.id}': callAction argument '${param.name}' must be a string`);
    } else if (param.default !== undefined) {
      if (param.secret === true && findTemplateVars(param.default).length === 0) {
        throw new CompileError(caller.id, `Step '${caller.id}': secret parameter '${param.name}' of action '${action.name}' has a plaintext default — defaults for secret params must be {{VARIABLE}} references`);
      }
      resolved[param.name] = param.default;
    } else {
      throw new CompileError(caller.id, `Step '${caller.id}': callAction is missing required argument '${param.name}' for action '${action.name}' (${action.id}) and the parameter has no default`);
    }
  }
  return resolved;
}

/**
 * Deep-clone a body step while interpolating `{{param}}` with resolved
 * argument values. Non-param `{{VAR}}` / `{{row.*}}` placeholders pass
 * through to the normal runtime lookups.
 */
function interpolateActionStep(step: TestStep, args: Record<string, string>): TestStep {
  const clone = JSON.parse(JSON.stringify(step)) as TestStep;
  const sub = (value: string): string =>
    value.replace(ACTION_PARAM_PATTERN, (m, name: string) =>
      Object.prototype.hasOwnProperty.call(args, name) ? args[name] : m,
    );
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return sub(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  return walk(clone) as TestStep;
}

/** One `await test.step(...)` line-block; inner/outer share timeout + continueOnFailure handling. */
function emitRunnerStep(
  titleExpr: string,
  bodyLine: string,
  opts: { timeoutMs?: number; continueOnFailure?: boolean; stepId: string },
  baseIndent: string,
): string[] {
  const timeoutOpt =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs)
      ? `, { timeout: ${opts.timeoutMs} }`
      : '';
  const inner = `${baseIndent}  `;
  let lines = [`${inner}${bodyLine}`];
  if (opts.continueOnFailure === true) {
    lines = [
      `${inner}try {`,
      `${inner}  ${bodyLine}`,
      `${inner}} catch {`,
      `${inner}  // continueOnFailure: step ${opts.stepId} failed, continuing.`,
      `${inner}}`,
    ];
  }
  return [
    `${baseIndent}await test.step(${titleExpr}, async () => {`,
    ...lines,
    `${baseIndent}}${timeoutOpt});`,
  ];
}

function emitCallAction(
  caller: TestStep,
  action: ReusableAction,
  baseIndent: string,
  dataset: boolean,
): string[] {
  const args = resolveActionArguments(caller, action);
  const title = `[${caller.id}] ${caller.name ?? action.name}`;
  const titleExpr = dataset ? `\`${escTemplate(title)} #\${_vvIteration + 1}\`` : esc(title);
  const innerIndent = `${baseIndent}  `;
  const inner: string[] = [];
  for (const bodyStep of action.steps) {
    if (bodyStep.type === 'callAction') {
      throw new CompileError(caller.id, `Step '${caller.id}': cannot inline action '${action.name}' (${action.id}) — nested callAction (body step '${bodyStep.id}') is rejected, action bodies must be P0 steps`);
    }
    // Runner convention: disabled steps are omitted (no StepRecord exists for
    // body steps, so there is nothing to mark skipped).
    if (!bodyStep.enabled) continue;
    const interpolated = interpolateActionStep(bodyStep, args);
    // No [id] prefix on inner titles: the reporter only tracks [id]-prefixed
    // steps, so the whole call attributes to the outer call-step record.
    const childTitle = interpolated.name ?? interpolated.type;
    const childExpr = dataset ? `\`${escTemplate(childTitle)} #\${_vvIteration + 1}\`` : esc(childTitle);
    inner.push(
      ...emitRunnerStep(childExpr, stepBody(interpolated), {
        timeoutMs: interpolated.timeoutMs,
        continueOnFailure: interpolated.continueOnFailure,
        stepId: interpolated.id,
      }, innerIndent),
    );
  }
  const timeoutOpt =
    typeof caller.timeoutMs === 'number' && Number.isFinite(caller.timeoutMs)
      ? `, { timeout: ${caller.timeoutMs} }`
      : '';
  let body = inner;
  if (caller.continueOnFailure === true) {
    body = [
      `${innerIndent}try {`,
      ...inner.map((line) => (line.length > 0 ? `  ${line}` : line)),
      `${innerIndent}} catch {`,
      `${innerIndent}  // continueOnFailure: step ${caller.id} failed, continuing.`,
      `${innerIndent}}`,
    ];
  }
  return [
    `${baseIndent}await test.step(${titleExpr}, async () => {`,
    ...body,
    `${baseIndent}}${timeoutOpt});`,
  ];
}

/** Deterministic spec source for one enabled-steps test. Disabled steps are omitted (reporter marks them skipped). */
export function compileSpec(
  test: TestDefinition,
  opts?: { testTimeoutMs?: number; datasetId?: string; actions?: ActionsContext },
): string {
  const dataset = resolveCompileDataset(test, opts?.datasetId);
  const enabled = test.steps.filter((s) => s.enabled);
  const lines: string[] = [
    `// Generated by runner compiler ${RUNNER_COMPILER_VERSION} — do not edit.`,
    `// Test: ${test.name} (${test.id})`,
    `import { test, expect } from '@playwright/test';`,
    ``,
    `test(${esc(test.name)}, async ({ page }) => {`,
  ];
  if (opts?.testTimeoutMs) lines.push(`  test.setTimeout(${opts.testTimeoutMs});`);
  const pad = dataset ? '  ' : '';
  if (dataset) {
    lines.push(`  // Data-driven: dataset ${esc(dataset.name)} (${dataset.id}) — rows from VV_DATASET_ROWS.`);
    lines.push(`  // Dataset rows are plaintext — never put secrets in datasets, use {{VARIABLES}} instead.`);
    lines.push(`  const VV_ROWS: Array<Record<string, string>> = JSON.parse(process.env.VV_DATASET_ROWS ?? '[]');`);
    lines.push(`  for (let _vvIteration = 0; _vvIteration < (VV_ROWS.length ? VV_ROWS.length : 1); _vvIteration++) {`);
    lines.push(`    const row: Record<string, string> = VV_ROWS[_vvIteration] ?? {};`);
  }
  for (const step of enabled) {
    if (step.type === 'callAction') {
      const actionId = step.actionId;
      const action = typeof actionId === 'string' ? lookupAction(opts?.actions, actionId) : undefined;
      if (!action) {
        throw new CompileError(step.id, typeof actionId === 'string' && actionId.length > 0
          ? `Step '${step.id}': callAction references unknown action '${actionId}' — pass it via compileSpec(test, { actions })`
          : `Step '${step.id}': callAction requires actionId`);
      }
      lines.push(...emitCallAction(step, action, `${pad}  `, dataset !== undefined));
      continue;
    }
    const title = `[${step.id}] ${step.name ?? step.type}`;
    const titleExpr = dataset ? `\`${escTemplate(title)} #\${_vvIteration + 1}\`` : esc(title);
    lines.push(`${pad}  await test.step(${titleExpr}, async () => {`);
    lines.push(`${pad}    ${stepBody(step)}`);
    if (step.timeoutMs) lines.push(`${pad}  }, { timeout: ${step.timeoutMs} });`);
    else lines.push(`${pad}  });`);
  }
  if (dataset) lines.push(`  }`);
  lines.push(`});`, ``);
  return lines.join('\n');
}

/**
 * Resolve the dataset for a data-driven compile. No datasetId → plain P0
 * output. Unknown id fails explicitly; `{{row.*}}` without a dataset fails
 * explicitly (there would be no `row` binding at run time).
 */
function resolveCompileDataset(
  test: TestDefinition,
  datasetId?: string,
): CompileDataSet | undefined {
  if (datasetId === undefined) {
    assertNoRowRefs(test);
    return undefined;
  }
  const found = (test.datasets ?? []).find((d) => d.id === datasetId);
  if (!found) {
    throw new CompileError(
      undefined,
      `Unknown datasetId '${datasetId}' (test has ${(test.datasets ?? []).length} dataset(s))`,
    );
  }
  return found;
}

/** Interpolated fields share the canonical compiler's INTERPOLATED_FIELDS set. */
function assertNoRowRefs(test: TestDefinition): void {
  const fields = ['url', 'value', 'key', 'expected', 'pattern'] as const;
  const walk = (v: unknown): boolean => {
    if (typeof v === 'string') return findRowRefs(v).length > 0;
    if (Array.isArray(v)) return v.some(walk);
    if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).some(walk);
    return false;
  };
  for (const step of test.steps) {
    if (!step.enabled) continue;
    for (const f of fields) {
      const rec = step as unknown as Record<string, unknown>;
      if (walk(rec[f])) {
        throw new CompileError(
          step.id,
          `Step '${step.id}' uses {{row.*}} but no dataset is selected — pass datasetId or remove the reference`,
        );
      }
    }
    // P1 actions: arguments interpolate into body-step value fields.
    if (step.type === 'callAction' && step.arguments) {
      for (const v of Object.values(step.arguments)) {
        if (typeof v === 'string' && findRowRefs(v).length > 0) {
          throw new CompileError(
            step.id,
            `Step '${step.id}' passes {{row.*}} into an action argument but no dataset is selected — pass datasetId or remove the reference`,
          );
        }
      }
    }
  }
}

export interface RunConfigOptions {
  browser: TestDefinition['browser'];
  headed?: boolean;
  baseUrl?: string;
  viewport?: { width: number; height: number };
  reporterPath: string;
  runId: string;
  trace: 'on' | 'off' | 'retain-on-failure';
  screenshot: 'on' | 'off' | 'only-on-failure';
  video: 'on' | 'off' | 'retain-on-failure';
  outputDir: string;
}

/** Playwright config for the isolated run: per-run context + custom reporter. */
export function compileConfig(opts: RunConfigOptions): string {
  return [
    `// Generated by runner compiler ${RUNNER_COMPILER_VERSION} — isolated run ${opts.runId}.`,
    `import { defineConfig, devices } from '@playwright/test';`,
    ``,
    `export default defineConfig({`,
    `  testDir: __dirname,`,
    `  testMatch: 'run.spec.ts',`,
    `  timeout: 0, // per-test timeout is set from the compiled spec`,
    `  outputDir: ${esc(opts.outputDir)},`,
    `  use: {`,
    ...(opts.baseUrl ? [`    baseURL: process.env.RUN_BASE_URL ?? ${esc(opts.baseUrl)},`] : []),
    `    browserName: ${esc(opts.browser)},`,
    `    headless: ${opts.headed ? 'false' : 'true'},`,
    ...(opts.viewport ? [`    viewport: { width: ${opts.viewport.width}, height: ${opts.viewport.height} },`] : []),
    `    trace: ${esc(opts.trace)},`,
    `    screenshot: ${esc(opts.screenshot)},`,
    `    video: ${esc(opts.video)},`,
    `    contextOptions: { storageState: undefined }, // fresh context per run, never reused`,
    `  },`,
    `  projects: [{ name: ${esc(opts.runId)}, use: { ...devices['Desktop Chrome'] } }],`,
    `  reporter: [[${esc(opts.reporterPath)}, { runId: ${esc(opts.runId)} }]],`,
    `});`,
    ``,
  ].join('\n');
}
