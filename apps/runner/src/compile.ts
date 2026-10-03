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

function locatorExpr(target: TestStep['target'], stepId: string, pageVar = 'page'): string {
  const primary: LocatorCandidate | undefined = target?.primary;
  if (!primary) throw new CompileError(stepId, `Step '${stepId}': missing target.primary`);
  switch (primary.strategy) {
    case 'role': {
      const opts = primary.name !== undefined ? `, { name: ${esc(primary.name)}${primary.exact ? ', exact: true' : ''} }` : '';
      return `${pageVar}.getByRole(${esc(primary.role)}${opts})`;
    }
    case 'label':
      return `${pageVar}.getByLabel(${esc(primary.value)}${primary.exact ? ', { exact: true }' : ''})`;
    case 'placeholder':
      return `${pageVar}.getByPlaceholder(${esc(primary.value)}${primary.exact ? ', { exact: true }' : ''})`;
    case 'testId':
      return `${pageVar}.getByTestId(${esc(primary.value)})`;
    case 'text':
      return `${pageVar}.getByText(${esc(primary.value)}${primary.exact ? ', { exact: true }' : ''})`;
    case 'css':
      return `${pageVar}.locator(${esc(primary.value)})`;
    case 'xpath':
      return `${pageVar}.locator(${esc(`xpath=${primary.value}`)})`;
    default:
      throw new CompileError(stepId, `Step '${stepId}': unsupported locator strategy '${(primary as { strategy: string }).strategy}'`);
  }
}

/**
 * P1 wave-2 semantics (mirrors packages/playwright-compiler; runner keeps
 * its own `[id]`-prefixed title dialect and `(process.env[…] ?? '')`
 * template shape):
 * - upload: run-time `VV_FILE_PATHS`/`FILE_PATHS` map lookup + explicit
 *   throw when the fileId entry is missing; never inlines paths.
 * - download with target: `waitForEvent('download')` + click + `saveAs`
 *   (or `suggestedFilename()`); url-only: `page.evaluate(fetch)` (browser
 *   cookies apply) + `node:fs/promises.writeFile`.
 * - newTab/closeTab: deterministic `page`/`page2`/… tracking in
 *   compileSpec; `closeTab` on the last tab fails explicitly.
 * - handleDialog: one-time `once('dialog')` for the NEXT dialog.
 * - apiRequest: `request` fixture; explicit throw on expectedStatus
 *   mismatch; `saveAs` stores `await resp.text()` into
 *   `process.env[saveAs]` for later `{{VAR}}` steps. Header/body values
 *   use `{{VAR}}` lookups (never inlined secrets); the runner redacts
 *   secret values from logs/result JSON via redactSecrets.
 */
function stepBody(step: TestStep, pageVar = 'page', newPageVar?: string): string {
  const loc = () => locatorExpr(step.target, step.id, pageVar);
  switch (step.type) {
    case 'goto':
      return `await ${pageVar}.goto(${templateExpr(step.url ?? '', 'url', step.id)});`;
    case 'reload':
      return `await ${pageVar}.reload();`;
    case 'goBack':
      return `await ${pageVar}.goBack();`;
    case 'goForward':
      return `await ${pageVar}.goForward();`;
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
      return step.target ? `await ${loc()}.press(${esc(step.key)});` : `await ${pageVar}.keyboard.press(${esc(step.key)});`;
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
      return `await ${pageVar}.waitForTimeout(${Number(ms)}); // WARNING: fixed wait is discouraged`;
    }
    case 'waitForURL':
      return `await ${pageVar}.waitForURL(${templateExpr(step.url ?? step.expected ?? step.pattern ?? '', 'expected', step.id)});`;
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
      return `await expect(${pageVar}).toHaveURL(${templateExpr(step.expected ?? step.pattern ?? '', 'expected', step.id)});`;
    case 'assertTitle':
      return `await expect(${pageVar}).toHaveTitle(${templateExpr(step.expected ?? '', 'expected', step.id)});`;
    case 'assertEnabled':
      return `await expect(${loc()}).toBeEnabled();`;
    case 'assertDisabled':
      return `await expect(${loc()}).toBeDisabled();`;
    case 'assertChecked':
      return `await expect(${loc()}).toBeChecked();`;
    case 'screenshot':
      return `await ${pageVar}.screenshot({ path: require('node:path').join(__dirname, '..', 'screenshots', ${esc(`${step.id}.png`)}), fullPage: ${step.fullPage ? 'true' : 'false'} });`;
    case 'upload': {
      if (!step.fileId) throw new CompileError(step.id, `Step '${step.id}': upload requires fileId`);
      const rec = step as unknown as Record<string, unknown>;
      const target = rec['target'] as TestStep['target'];
      if (!target?.primary) throw new CompileError(step.id, `Step '${step.id}': upload requires target.primary`);
      const l = locatorExpr(target, step.id, pageVar);
      return [
        `const vvFile = (JSON.parse(process.env.VV_FILE_PATHS ?? process.env.FILE_PATHS ?? '{}') as Record<string, string>)[${esc(step.fileId)}];`,
        `if (!vvFile) throw new Error(${esc(`upload '${step.id}': no file path for fileId '${step.fileId}' (runner injects VV_FILE_PATHS map)`)});`,
        `await ${l}.setInputFiles(vvFile);`,
      ].join('\n');
    }
    case 'download': {
      const rec = step as unknown as Record<string, unknown>;
      const target = rec['target'] as TestStep['target'] | undefined;
      const url = typeof rec['url'] === 'string' && rec['url'] ? (rec['url'] as string) : undefined;
      const saveAs = typeof rec['saveAs'] === 'string' && rec['saveAs'] ? (rec['saveAs'] as string) : undefined;
      if (!target && !url) {
        throw new CompileError(step.id, `Step '${step.id}': download requires at least one of 'target' or 'url' — failing compilation, never silently skipping`);
      }
      if (target) {
        if (!target.primary) throw new CompileError(step.id, `Step '${step.id}': download requires target.primary`);
        const l = locatorExpr(target, step.id, pageVar);
        const saveExpr = saveAs ? esc(saveAs) : 'download.suggestedFilename()';
        return [
          `const downloadPromise = ${pageVar}.waitForEvent('download');`,
          `await ${l}.click();`,
          `const download = await downloadPromise;`,
          `await download.saveAs(${saveExpr});`,
        ].join('\n');
      }
      const outName = saveAs ?? `download-${step.id}`;
      return [
        `const vvBytes = await ${pageVar}.evaluate(async (vvUrl: string) => {`,
        `  const vvRes = await fetch(vvUrl);`,
        `  if (!vvRes.ok) throw new Error(${esc(`download '${step.id}' failed with status `)} + vvRes.status);`,
        `  return [...new Uint8Array(await vvRes.arrayBuffer())];`,
        `}, ${templateExpr(url!, 'url', step.id)});`,
        `await (await import('node:fs/promises')).writeFile(${esc(outName)}, Buffer.from(vvBytes));`,
      ].join('\n');
    }
    case 'newTab': {
      if (!newPageVar) {
        throw new CompileError(step.id, `Step '${step.id}': newTab requires a deterministic page name — compile via compileSpec() so tabs are named page/page2/... explicitly`);
      }
      const rec = step as unknown as Record<string, unknown>;
      const url = typeof rec['url'] === 'string' && rec['url'] ? (rec['url'] as string) : undefined;
      const lines = [`const ${newPageVar} = await context.newPage();`];
      if (url) lines.push(`await ${newPageVar}.goto(${templateExpr(url, 'url', step.id)});`);
      return lines.join('\n');
    }
    case 'closeTab':
      return `await ${pageVar}.close();`;
    case 'handleDialog': {
      const rec = step as unknown as Record<string, unknown>;
      const action = rec['action'];
      if (action !== 'accept' && action !== 'dismiss') {
        throw new CompileError(step.id, `Step '${step.id}': handleDialog requires action 'accept'|'dismiss'`);
      }
      const promptText = typeof rec['promptText'] === 'string' && rec['promptText'] ? (rec['promptText'] as string) : undefined;
      if (action === 'accept') {
        return promptText
          ? `${pageVar}.once('dialog', async (dialog) => { await dialog.accept(${templateExpr(promptText, 'promptText', step.id)}); });`
          : `${pageVar}.once('dialog', async (dialog) => { await dialog.accept(); });`;
      }
      return `${pageVar}.once('dialog', async (dialog) => { await dialog.dismiss(); });`;
    }
    case 'apiRequest':
      return apiRequestBody(step);
    case 'callAction':
      throw new CompileError(step.id, `Step '${step.id}': callAction needs an actions context — pass { actions } to compileSpec() so the callee body can be inlined explicitly`);
    default:
      throw new CompileError(step.id, `Step '${step.id}': unsupported step type '${step.type}' — failing compilation, never silently skipping`);
  }
}

/** apiRequest -> `request` fixture call with explicit status check + saveAs. */
function apiRequestBody(step: TestStep): string {
  const rec = step as unknown as Record<string, unknown>;
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  const method = rec['method'];
  if (typeof method !== 'string' || !methods.includes(method)) {
    throw new CompileError(step.id, `Step '${step.id}': apiRequest requires method ${methods.join('|')}`);
  }
  const url = rec['url'];
  if (typeof url !== 'string' || url.length === 0) {
    throw new CompileError(step.id, `Step '${step.id}': apiRequest requires url`);
  }
  const headersRaw = rec['headers'];
  let headersExpr: string | undefined;
  if (headersRaw !== undefined) {
    if (!headersRaw || typeof headersRaw !== 'object' || Array.isArray(headersRaw)) {
      throw new CompileError(step.id, `Step '${step.id}': apiRequest headers must be a record of strings`);
    }
    const entries = Object.entries(headersRaw as Record<string, unknown>);
    for (const [k, v] of entries) {
      if (typeof v !== 'string') throw new CompileError(step.id, `Step '${step.id}': apiRequest header '${k}' must be a string (use {{VARIABLE}} for secrets)`);
    }
    const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    headersExpr = `{ ${sorted.map(([k, v]) => `${esc(k)}: ${templateExpr(v as string, `headers.${k}`, step.id)}`).join(', ')} }`;
  }
  const bodyRaw = rec['body'];
  let bodyExpr: string | undefined;
  if (bodyRaw !== undefined) {
    if (typeof bodyRaw !== 'string') throw new CompileError(step.id, `Step '${step.id}': apiRequest body must be a string (use {{VARIABLE}} for secrets)`);
    bodyExpr = templateExpr(bodyRaw, 'body', step.id);
  }
  const expectedRaw = rec['expectedStatus'];
  if (expectedRaw !== undefined && !(Number.isInteger(expectedRaw) && (expectedRaw as number) >= 100 && (expectedRaw as number) <= 599)) {
    throw new CompileError(step.id, `Step '${step.id}': apiRequest expectedStatus must be an integer 100-599`);
  }
  const saveAsRaw = rec['saveAs'];
  if (saveAsRaw !== undefined && !(typeof saveAsRaw === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(saveAsRaw))) {
    throw new CompileError(step.id, `Step '${step.id}': apiRequest saveAs must match /^[A-Za-z_][A-Za-z0-9_]*$/`);
  }
  const fn = (method as string).toLowerCase();
  const opts: string[] = [];
  if (headersExpr) opts.push(`headers: ${headersExpr}`);
  if (bodyExpr) opts.push(`data: ${bodyExpr}`);
  const urlExpr = templateExpr(url as string, 'url', step.id);
  const call = opts.length > 0 ? `await request.${fn}(${urlExpr}, { ${opts.join(', ')} })` : `await request.${fn}(${urlExpr})`;
  const lines = [`const vvResp = ${call};`];
  if (typeof expectedRaw === 'number') {
    lines.push(`if (vvResp.status() !== ${Math.trunc(expectedRaw)}) throw new Error(${esc(`apiRequest '${step.id}': expected status ${Math.trunc(expectedRaw)} but got `)} + vvResp.status());`);
  }
  if (typeof saveAsRaw === 'string' && saveAsRaw) {
    lines.push(`process.env[${esc(saveAsRaw)}] = await vvResp.text();`);
  }
  return lines.join('\n');
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
  body: string,
  opts: { timeoutMs?: number; continueOnFailure?: boolean; stepId: string },
  baseIndent: string,
): string[] {
  const timeoutOpt =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs)
      ? `, { timeout: ${opts.timeoutMs} }`
      : '';
  const inner = `${baseIndent}  `;
  const bodyLines = body.split('\n').map((line) => `${inner}${line}`);
  let lines = bodyLines;
  if (opts.continueOnFailure === true) {
    lines = [
      `${inner}try {`,
      ...bodyLines.map((line) => (line.length > 0 ? `  ${line}` : line)),
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
  pageVar = 'page',
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
    if (bodyStep.type === 'newTab' || bodyStep.type === 'closeTab') {
      throw new CompileError(caller.id, `Step '${caller.id}': cannot inline action '${action.name}' (${action.id}) — body step '${bodyStep.id}' (${bodyStep.type}) manages tabs, multi-tab state never crosses the action boundary`);
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
      ...emitRunnerStep(childExpr, stepBody(interpolated, pageVar), {
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
  const needsContext = enabled.some((s) => s.type === 'newTab');
  const needsRequest = enabled.some((s) => {
    if (s.type === 'apiRequest') return true;
    if (s.type === 'callAction') {
      const action = typeof s.actionId === 'string' ? lookupAction(opts?.actions, s.actionId) : undefined;
      return !!action?.steps.some((b) => b.enabled !== false && b.type === 'apiRequest');
    }
    return false;
  });
  const fixtures = ['page', ...(needsContext ? ['context'] : []), ...(needsRequest ? ['request'] : [])].join(', ');
  const lines: string[] = [
    `// Generated by runner compiler ${RUNNER_COMPILER_VERSION} — do not edit.`,
    `// Test: ${test.name} (${test.id})`,
    `import { test, expect } from '@playwright/test';`,
    ``,
    `test(${esc(test.name)}, async ({ ${fixtures} }) => {`,
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
  // P1 wave-2 tab tracking mirrors the package compiler: deterministic
  // `page`/`page2`/… stack; `closeTab` on the last tab fails explicitly.
  const pageStack: string[] = ['page'];
  let pageCounter = 1;
  const emitTopLevel = (step: TestStep, body: string): void => {
    const title = `[${step.id}] ${step.name ?? step.type}`;
    const titleExpr = dataset ? `\`${escTemplate(title)} #\${_vvIteration + 1}\`` : esc(title);
    lines.push(`${pad}  await test.step(${titleExpr}, async () => {`);
    for (const raw of body.split('\n')) lines.push(`${pad}    ${raw}`);
    if (step.timeoutMs) lines.push(`${pad}  }, { timeout: ${step.timeoutMs} });`);
    else lines.push(`${pad}  });`);
  };
  for (const step of enabled) {
    if (step.type === 'newTab') {
      pageCounter += 1;
      const newPageVar = pageCounter === 2 ? 'page2' : `page${pageCounter}`;
      const currentPage = pageStack[pageStack.length - 1];
      emitTopLevel(step, stepBody(step, currentPage, newPageVar));
      pageStack.push(newPageVar);
      continue;
    }
    if (step.type === 'closeTab') {
      if (pageStack.length <= 1) {
        throw new CompileError(step.id, `Step '${step.id}': closeTab cannot close the last remaining tab — at least one page must stay open`);
      }
      const currentPage = pageStack[pageStack.length - 1];
      emitTopLevel(step, stepBody(step, currentPage));
      pageStack.pop();
      continue;
    }
    if (step.type === 'callAction') {
      const actionId = step.actionId;
      const action = typeof actionId === 'string' ? lookupAction(opts?.actions, actionId) : undefined;
      if (!action) {
        throw new CompileError(step.id, typeof actionId === 'string' && actionId.length > 0
          ? `Step '${step.id}': callAction references unknown action '${actionId}' — pass it via compileSpec(test, { actions })`
          : `Step '${step.id}': callAction requires actionId`);
      }
      lines.push(...emitCallAction(step, action, `${pad}  `, dataset !== undefined, pageStack[pageStack.length - 1]));
      continue;
    }
    emitTopLevel(step, stepBody(step, pageStack[pageStack.length - 1]));
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
  const fields = ['url', 'value', 'key', 'expected', 'pattern', 'body', 'headers', 'promptText'] as const;
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
  /**
   * P1 auth context: relative filename of the materialized storageState
   * JSON inside the isolated workDir (e.g. `storageState.json`). When
   * undefined (default) the config keeps `storageState: undefined` —
   * byte-identical to P0 (fresh context per run, never reused).
   */
  storageStateFile?: string;
}

/** Playwright config for the isolated run: per-run context + custom reporter. */
export function compileConfig(opts: RunConfigOptions): string {
  const storageStateLine = opts.storageStateFile
    ? `    contextOptions: { storageState: ${esc(opts.storageStateFile)} }, // P1 auth context materialized per run`
    : `    contextOptions: { storageState: undefined }, // fresh context per run, never reused`;
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
    storageStateLine,
    `  },`,
    `  projects: [{ name: ${esc(opts.runId)}, use: { ...devices['Desktop Chrome'] } }],`,
    `  reporter: [[${esc(opts.reporterPath)}, { runId: ${esc(opts.runId)} }]],`,
    `});`,
    ``,
  ].join('\n');
}
