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
import { HEALING_PROBE_BUDGET_MS, isLocatorBearingStep } from './healing.js';

type CompileDataSet = NonNullable<TestDefinition['datasets']>[number];

export const RUNNER_COMPILER_VERSION = 'p0-runner-1';

/**
 * P2 — visual regression + plugin steps (additive mirror of
 * packages/playwright-compiler; this file keeps its own `[id]` title dialect
 * and `(process.env[…] ?? '')` template shape, so P0 output is byte-identical
 * when no P2 step is present).
 *
 * - `visualCheck` screenshots into the artifact dir and diffs via the
 *   workdir helper `./vv-visual-compare.cjs` (pure self-written PNG codec,
 *   see visual-compare.ts — no new dependency).
 * - `plugin:<name>` steps call `./vv-plugins.cjs`, materialized from the
 *   trusted registry; unknown types fail with PLUGIN_NOT_FOUND (compile time
 *   when `opts.plugins` is passed, run time otherwise — never silent).
 */
export const VISUAL_DEFAULT_THRESHOLD = 0.05;

/** P2 plugin step types are namespaced `plugin:<name>` (globally unique). */
export const PLUGIN_STEP_PATTERN = /^plugin:[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Deterministic artifact filename (must match the package compiler exactly). */
export function sanitizeVisualFileName(name: string): string {
  const safe = String(name).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 120);
  return `visual-${safe.length > 0 ? safe : 'check'}.png`;
}

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

/**
 * Mirror of the canonical `compileUrlMatcher` (packages/playwright-compiler):
 * tester glob (`*`/`**`) in a PURE literal becomes `new RegExp(...)` because
 * Playwright compares plain URL strings literally. Templates pass through.
 */
function urlMatcherExpr(template: string, field: string, stepId: string): string {
  if (!template.includes('*') || findTemplateVars(template).length > 0 || findRowRefs(template).length > 0) {
    return templateExpr(template, field, stepId);
  }
  let src = '';
  for (let i = 0; i < template.length; i++) {
    const c = template[i] as string;
    if (c === '*') {
      if (template[i + 1] === '*') {
        src += '.*';
        i++;
      } else {
        src += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      src += `\\${c}`;
    } else {
      src += c;
    }
  }
  return `new RegExp(${esc(`^${src}$`)})`;
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

function candidateExpr(candidate: LocatorCandidate, stepId: string, scopeExpr: string): string {
  switch (candidate.strategy) {
    case 'role': {
      const c = candidate as { role: string; name?: string; exact?: boolean };
      const opts = c.name !== undefined ? `, { name: ${esc(c.name)}${c.exact ? ', exact: true' : ''} }` : '';
      return `${scopeExpr}.getByRole(${esc(c.role)}${opts})`;
    }
    case 'label': {
      const c = candidate as { value: string; exact?: boolean };
      return `${scopeExpr}.getByLabel(${esc(c.value)}${c.exact ? ', { exact: true }' : ''})`;
    }
    case 'placeholder': {
      const c = candidate as { value: string; exact?: boolean };
      return `${scopeExpr}.getByPlaceholder(${esc(c.value)}${c.exact ? ', { exact: true }' : ''})`;
    }
    case 'testId': {
      const c = candidate as { value: string };
      return `${scopeExpr}.getByTestId(${esc(c.value)})`;
    }
    case 'text': {
      const c = candidate as { value: string; exact?: boolean };
      return `${scopeExpr}.getByText(${esc(c.value)}${c.exact ? ', { exact: true }' : ''})`;
    }
    case 'css': {
      const c = candidate as { value: string };
      return `${scopeExpr}.locator(${esc(c.value)})`;
    }
    case 'xpath': {
      const c = candidate as { value: string };
      return `${scopeExpr}.locator(${esc(`xpath=${c.value}`)})`;
    }
    default:
      throw new CompileError(stepId, `Step '${stepId}': unsupported locator strategy '${(candidate as { strategy: string }).strategy}'`);
  }
}

function locatorExpr(target: TestStep['target'], stepId: string, pageVar = 'page'): string {  const primary: LocatorCandidate | undefined = target?.primary;
  if (!primary) throw new CompileError(stepId, `Step '${stepId}': missing target.primary`);
  return candidateExpr(primary, stepId, pageVar);
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
/**
 * Step timeout also governs expect() polling: Playwright's `test.step`
 * timeout does NOT extend assertion waits (expect defaults to 5s), so a
 * step-level timeoutMs must be forwarded explicitly — otherwise raising a
 * step timeout has no effect on assertions and slow pages fail identically.
 * Returns '' when unset (output byte-identical to before).
 */
function expectTimeout(step: TestStep): string {
  const ms = (step as unknown as { timeoutMs?: unknown }).timeoutMs;
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? `{ timeout: ${Math.trunc(ms)} }` : '';
}

/**
 * Iframe scope for locator-bearing steps: `page.frameLocator(...)` when
 * step.frame is set (Stripe Elements etc.), else the page itself.
 * Page-level calls (goto, route, screenshot, keyboard) keep pageVar.
 */
function frameScopeExpr(step: TestStep, pageVar: string): string {
  const rec = step as unknown as { frame?: { url?: unknown; name?: unknown } };
  const cssEscape = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const url = rec.frame?.url;
  const name = rec.frame?.name;
  if (typeof url === 'string' && url.length > 0 && url.length <= 2000) {
    return `${pageVar}.frameLocator(${esc(`iframe[src*="${cssEscape(url)}"]`)})`;
  }
  if (typeof name === 'string' && name.length > 0 && name.length <= 500) {
    return `${pageVar}.frameLocator(${esc(`iframe[name="${cssEscape(name)}"]`)})`;
  }
  if (rec.frame !== undefined) {
    throw new CompileError(step.id, `Step '${step.id}': frame needs url (substring of the iframe src)`);
  }
  return pageVar;
}

function stepBody(step: TestStep, pageVar = 'page', newPageVar?: string): string {
  // P2 plugin steps dispatch before the literal switch (prefix-matched).
  if (typeof step.type === 'string' && PLUGIN_STEP_PATTERN.test(step.type)) {
    return pluginStepBody(step, pageVar);
  }
  const loc = () => locatorExpr(step.target, step.id, frameScopeExpr(step, pageVar));
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
      return `await ${pageVar}.waitForURL(${urlMatcherExpr(step.url ?? step.expected ?? step.pattern ?? '', 'expected', step.id)});`;
    case 'assertVisible': {
      const t = expectTimeout(step);
      return `await expect(${loc()}).toBeVisible(${t});`;
    }
    case 'assertHidden': {
      const t = expectTimeout(step);
      return `await expect(${loc()}).toBeHidden(${t});`;
    }
    case 'assertText': {
      const t = expectTimeout(step);
      return `await expect(${loc()}).toHaveText(${templateExpr(step.expected ?? '', 'expected', step.id)}${t ? `, ${t}` : ''});`;
    }
    case 'assertContainsText': {
      const t = expectTimeout(step);
      return `await expect(${loc()}).toContainText(${templateExpr(step.expected ?? '', 'expected', step.id)}${t ? `, ${t}` : ''});`;
    }
    case 'assertValue': {
      const t = expectTimeout(step);
      return `await expect(${loc()}).toHaveValue(${templateExpr(step.expected ?? '', 'expected', step.id)}${t ? `, ${t}` : ''});`;
    }
    case 'assertURL': {
      const t = expectTimeout(step);
      return `await expect(${pageVar}).toHaveURL(${urlMatcherExpr(step.expected ?? step.pattern ?? '', 'expected', step.id)}${t ? `, ${t}` : ''});`;
    }
    case 'assertTitle': {
      const t = expectTimeout(step);
      return `await expect(${pageVar}).toHaveTitle(${templateExpr(step.expected ?? '', 'expected', step.id)}${t ? `, ${t}` : ''});`;
    }
    case 'assertEnabled': {
      const t = expectTimeout(step);
      return `await expect(${loc()}).toBeEnabled(${t});`;
    }
    case 'assertDisabled': {
      const t = expectTimeout(step);
      return `await expect(${loc()}).toBeDisabled(${t});`;
    }
    case 'assertChecked': {
      const t = expectTimeout(step);
      return `await expect(${loc()}).toBeChecked(${t});`;
    }
    case 'screenshot':
      // Screenshots are run evidence: write into the run artifact dir (runner
      // injects RUN_ARTIFACT_DIR) so collectArtifacts() persists them. The old
      // __dirname-relative path landed in the temp compile dir, which is
      // cleaned up — screenshots silently never reached storage.
      return `await ${pageVar}.screenshot({ path: require('node:path').join(process.env.RUN_ARTIFACT_DIR ?? '.', 'screenshots', ${esc(`${step.id}.png`)}), fullPage: ${step.fullPage ? 'true' : 'false'} });`;
    case 'visualCheck':
      return visualCheckBody(step, pageVar);
    case 'upload': {
      if (!step.fileId) throw new CompileError(step.id, `Step '${step.id}': upload requires fileId`);
      const rec = step as unknown as Record<string, unknown>;
      const target = rec['target'] as TestStep['target'];
      if (!target?.primary) throw new CompileError(step.id, `Step '${step.id}': upload requires target.primary`);
      const l = locatorExpr(target, step.id, frameScopeExpr(step, pageVar));
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
        const l = locatorExpr(target, step.id, frameScopeExpr(step, pageVar));
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
    case 'mockRoute':
      return mockRouteBody(step, pageVar);
    case 'axeCheck':
      return axeCheckBody(step, pageVar);
    case 'callAction':
      throw new CompileError(step.id, `Step '${step.id}': callAction needs an actions context — pass { actions } to compileSpec() so the callee body can be inlined explicitly`);
    default:
      throw new CompileError(step.id, `Step '${step.id}': unsupported step type '${step.type}' — failing compilation, never silently skipping`);
  }
}

/** P2 visual regression: screenshot into the artifact dir, then diff via the workdir helper. */
function visualCheckBody(step: TestStep, pageVar: string): string {
  const rec = step as unknown as Record<string, unknown>;
  const name = rec['name'];
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) {
    throw new CompileError(step.id, `Step '${step.id}': visualCheck requires name (1-200 chars)`);
  }
  const thresholdRaw = rec['threshold'];
  const threshold = thresholdRaw === undefined ? VISUAL_DEFAULT_THRESHOLD : thresholdRaw;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new CompileError(step.id, `Step '${step.id}': visualCheck threshold must be a number in [0, 1]`);
  }
  const fileName = sanitizeVisualFileName(name);
  const target = rec['target'] as TestStep['target'] | undefined;
  const shotTarget = target ? locatorExpr(target, step.id, frameScopeExpr(step, pageVar)) : pageVar;
  if (target && !target.primary) {
    throw new CompileError(step.id, `Step '${step.id}': visualCheck requires target.primary`);
  }
  return [
    `const vvVisualPath = require('node:path').join(process.env.RUN_ARTIFACT_DIR ?? '.', 'screenshots', ${esc(fileName)});`,
    `await ${shotTarget}.screenshot({ path: vvVisualPath });`,
    `await require('./vv-visual-compare.cjs').compareVisualFromEnv({ name: ${esc(name)}, actualPath: vvVisualPath, threshold: ${JSON.stringify(threshold)} });`,
  ].join('\n');
}

/** P2 plugin step: call the registered helper with templated string params. */
function pluginStepBody(step: TestStep, pageVar: string): string {
  const rec = step as unknown as Record<string, unknown>;
  const rawParams = rec['params'];
  let params: Record<string, string>;
  if (rawParams === undefined) {
    params = {};
  } else if (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)) {
    params = {};
    for (const [k, v] of Object.entries(rawParams as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new CompileError(step.id, `Step '${step.id}': ${step.type} param '${k}' must be a string (use {{VARIABLE}} for secrets)`);
      }
      params[k] = v;
    }
  } else {
    throw new CompileError(step.id, `Step '${step.id}': ${step.type} params must be a record of strings`);
  }
  const entries = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const paramsExpr = `{ ${entries.map(([k, v]) => `${esc(k)}: ${templateExpr(v, `params.${k}`, step.id)}`).join(', ')} }`;
  return `await require('./vv-plugins.cjs').runPluginStep(${esc(step.type)}, ${paramsExpr}, ${pageVar}, { stepId: ${esc(step.id)} });`;
}

/**
 * Fail fast for plugin steps when the registry snapshot is available
 * (mirror of the package compiler's assertPluginStep): unknown type ->
 * PLUGIN_NOT_FOUND; missing required param / plaintext secret literal ->
 * CompileError. Without the snapshot these move to the run-time helper.
 */
export interface PluginCompileInfo {
  schema?: {
    required?: string[];
    properties?: Record<string, { type: string; maxLength?: number; default?: string; secret?: boolean }>;
  };
}

function assertPluginStep(step: TestStep, plugins?: Record<string, PluginCompileInfo>): void {
  if (!plugins) return;
  const info = Object.prototype.hasOwnProperty.call(plugins, step.type) ? plugins[step.type] : undefined;
  if (!info) {
    throw new CompileError(step.id, `Step '${step.id}': PLUGIN_NOT_FOUND — plugin step '${step.type}' is not registered (install under PLUGINS_DIR, enable with ALLOW_PLUGINS=1 after Developer/Admin review)`);
  }
  const schema = info.schema;
  if (!schema) return;
  const raw = (step as unknown as Record<string, unknown>)['params'];
  const params = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  for (const req of schema.required ?? []) {
    if (typeof params[req] !== 'string') {
      throw new CompileError(step.id, `Step '${step.id}': ${step.type} is missing required param '${req}'`);
    }
  }
  for (const [k, decl] of Object.entries(schema.properties ?? {})) {
    const v = params[k];
    if (typeof v === 'string' && decl.secret === true && findTemplateVars(v).length === 0) {
      throw new CompileError(step.id, `Step '${step.id}': ${step.type} secret param '${k}' must be a {{VARIABLE}} reference so the secret is resolved at run time, never inlined`);
    }
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
 * mockRoute -> `page.route()` interception registered BEFORE the app fires
 * the request (ordering is the author's job — put it before goto/click).
 * Method filter falls through to the network; everything else fulfills.
 * Deterministic: same fields always emit the same lines (no timestamps).
 */
function mockRouteBody(step: TestStep, pageVar: string): string {
  const rec = step as unknown as Record<string, unknown>;
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  const url = rec['url'];
  if (typeof url !== 'string' || url.length === 0) {
    throw new CompileError(step.id, `Step '${step.id}': mockRoute requires url (glob/pattern)`);
  }
  const method = rec['method'];
  if (method !== undefined && (typeof method !== 'string' || !methods.includes(method))) {
    throw new CompileError(step.id, `Step '${step.id}': mockRoute requires method ${methods.join('|')}`);
  }
  const statusRaw = rec['status'];
  if (statusRaw !== undefined && !(Number.isInteger(statusRaw) && (statusRaw as number) >= 100 && (statusRaw as number) <= 599)) {
    throw new CompileError(step.id, `Step '${step.id}': mockRoute requires status 100-599`);
  }
  const bodyRaw = rec['body'];
  if (bodyRaw !== undefined && typeof bodyRaw !== 'string') {
    throw new CompileError(step.id, `Step '${step.id}': mockRoute body must be a string (use {{VARIABLE}})`);
  }
  const ctRaw = rec['contentType'];
  if (ctRaw !== undefined && (typeof ctRaw !== 'string' || ctRaw.length === 0 || ctRaw.length > 200)) {
    throw new CompileError(step.id, `Step '${step.id}': mockRoute contentType must be 1-200 chars`);
  }
  const urlExpr = templateExpr(url, 'url', step.id);
  const fulfill: string[] = [`status: ${statusRaw !== undefined ? Math.trunc(statusRaw as number) : 200}`];
  if (typeof ctRaw === 'string') fulfill.push(`contentType: ${esc(ctRaw)}`);
  if (typeof bodyRaw === 'string') fulfill.push(`body: ${templateExpr(bodyRaw, 'body', step.id)}`);
  const handler =
    typeof method === 'string'
      ? `async (vvRoute) => { if (vvRoute.request().method() !== ${esc(method)}) return vvRoute.fallback(); await vvRoute.fulfill({ ${fulfill.join(', ')} }); }`
      : `async (vvRoute) => { await vvRoute.fulfill({ ${fulfill.join(', ')} }); }`;
  return `await ${pageVar}.route(${urlExpr}, ${handler});`;
}

/**
 * axeCheck -> axe-core scan (wcag2a/2aa/21a/21aa). Fails explicitly with
 * rule ids + node counts. axe runs in the page; results are data (no secrets
 * by construction, and error text passes through runner secret redaction).
 */
function axeCheckBody(step: TestStep, pageVar: string): string {
  const rec = step as unknown as Record<string, unknown>;
  const impacts = ['critical', 'serious', 'moderate', 'minor'];
  const selector = rec['selector'];
  if (selector !== undefined && (typeof selector !== 'string' || selector.length === 0 || selector.length > 2000)) {
    throw new CompileError(step.id, `Step '${step.id}': axeCheck requires selector (1-2000 chars CSS)`);
  }
  const incRaw = rec['includedImpacts'];
  const included: string[] =
    incRaw === undefined
      ? ['critical', 'serious']
      : Array.isArray(incRaw) && incRaw.length > 0 && incRaw.length <= 4 && incRaw.every((v) => typeof v === 'string' && impacts.includes(v))
        ? [...(incRaw as string[])].sort()
        : (() => { throw new CompileError(step.id, `Step '${step.id}': axeCheck requires includedImpacts from ${impacts.join('|')}`); })();
  const disRaw = rec['disableRules'];
  if (disRaw !== undefined && (!Array.isArray(disRaw) || (disRaw as unknown[]).some((v) => typeof v !== 'string' || (v as string).length === 0 || (v as string).length > 120) || (disRaw as unknown[]).length > 100)) {
    throw new CompileError(step.id, `Step '${step.id}': axeCheck requires disableRules string[<=100]`);
  }
  const lines = [
    // @axe-core/playwright resolves via NODE_PATH in the isolated workdir
    // (runner injects its node_modules); the vv-axe.cjs shim next to the spec
    // re-exports it so both CJS and ESM spec transforms can load it.
    `const vvAxeMod = await import('./vv-axe.cjs');`,
    `const vvAxeBuilder = new (vvAxeMod.default ?? vvAxeMod)({ page: ${pageVar} }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);`,
  ];
  if (typeof selector === 'string') lines.push(`vvAxeBuilder.include(${esc(selector)});`);
  if (Array.isArray(disRaw) && (disRaw as unknown[]).length > 0) {
    lines.push(`vvAxeBuilder.disableRules(${JSON.stringify(disRaw)});`);
  }
  lines.push(`const vvAxe = await vvAxeBuilder.analyze();`);
  lines.push(`const vvAxeBad = vvAxe.violations.filter((vv) => ${JSON.stringify(included)}.includes(vv.impact));`);
  lines.push(`if (vvAxeBad.length > 0) throw new Error(${esc(`axeCheck '${step.id}': `)} + vvAxeBad.length + ${esc(' violation(s): ')} + vvAxeBad.map((vv) => vv.id + '[' + vv.impact + ']').join(', '));`);
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
/**
 * P2 healing probe wrapper (flag-gated, `compileSpec(test, { healingProbe })`).
 * On primary failure, each stored alternative is counted read-only
 * (`.count()` never waits — bounded, immediate) and one JSON line is
 * appended to VV_HEALING_PATH. The original error is always rethrown: the
 * step keeps `failed`, nothing is silently healed. Without the flag the
 * output is byte-identical to before (P0 primary-only unchanged).
 */
const HEALING_PROBE_MAX = 8;

function safeStepVar(stepId: string): string {
  const s = stepId.replace(/[^A-Za-z0-9_$]/g, '_');
  return s.length > 0 ? s : 'step';
}

function healingProbeBody(step: TestStep, body: string, scopeExpr: string): string | null {
  const alternatives = step.target?.alternatives ?? [];
  if (!isLocatorBearingStep(step) || alternatives.length === 0) return null;
  const v = safeStepVar(step.id);
  const checks = alternatives.slice(0, HEALING_PROBE_MAX).map((alt, i) => {
    const expr = candidateExpr(alt, step.id, scopeExpr);
    return `if (vvWinner_${v} === -1) { try { const vvN_${v}_${i} = await (${expr}).count(); vvTried_${v}.push(vvN_${v}_${i}); if (vvN_${v}_${i} === 1) { vvWinner_${v} = ${i}; } } catch { vvTried_${v}.push(-1); } }`;
  });
  return [
    `try {`,
    ...body.split('\n').map((l) => `  ${l}`),
    `} catch (vvErr_${v}) {`,
    `  const vvTried_${v}: number[] = [];`,
    `  let vvWinner_${v} = -1;`,
    ...checks.map((c) => `  ${c}`),
    `  if (process.env.VV_HEALING_PATH) { try { require('node:fs').appendFileSync(process.env.VV_HEALING_PATH, JSON.stringify({ stepId: ${esc(step.id)}, tried: vvTried_${v}, winner: vvWinner_${v} }) + '\\n'); } catch { /* evidence best-effort; original error still throws */ } }`,
    `  throw vvErr_${v};`,
    `}`,
  ].join('\n');
}

function emitRunnerStep(
  titleExpr: string,
  body: string,
  opts: { timeoutMs?: number; continueOnFailure?: boolean; stepId: string; healing?: { step: TestStep; scopeExpr: string } },
  baseIndent: string,
): string[] {
  // P2 healing headroom: the probe wrapper needs budget past the step
  // timeout, otherwise probes die with the timed-out step (unverified).
  const timeoutMs = opts.healing && typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs)
    ? opts.timeoutMs + HEALING_PROBE_BUDGET_MS
    : opts.timeoutMs;
  const timeoutOpt =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
      ? `, { timeout: ${timeoutMs} }`
      : '';
  const inner = `${baseIndent}  `;
  const probed = opts.healing ? healingProbeBody(opts.healing.step, body, opts.healing.scopeExpr) : null;
  const bodyLines = (probed ?? body).split('\n').map((line) => `${inner}${line}`);
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
  healingProbe = false,
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
        ...(healingProbe ? { healing: { step: interpolated, scopeExpr: frameScopeExpr(interpolated, pageVar) } } : {}),
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
  opts?: { testTimeoutMs?: number; datasetId?: string; actions?: ActionsContext; plugins?: Record<string, PluginCompileInfo>; healingProbe?: boolean },
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
  const emitTopLevel = (step: TestStep, body: string, pageVar: string): void => {
    const title = `[${step.id}] ${step.name ?? step.type}`;
    const titleExpr = dataset ? `\`${escTemplate(title)} #\${_vvIteration + 1}\`` : esc(title);
    const probed = opts?.healingProbe === true
      ? (healingProbeBody(step, body, frameScopeExpr(step, pageVar)) ?? body)
      : body;
    lines.push(`${pad}  await test.step(${titleExpr}, async () => {`);
    for (const raw of probed.split('\n')) lines.push(`${pad}    ${raw}`);
    const healingHeadroom = opts?.healingProbe === true && typeof step.timeoutMs === 'number' && Number.isFinite(step.timeoutMs);
    if (step.timeoutMs) lines.push(`${pad}  }, { timeout: ${step.timeoutMs + (healingHeadroom ? HEALING_PROBE_BUDGET_MS : 0)} });`);
    else lines.push(`${pad}  });`);
  };
  for (const step of enabled) {
    if (step.type === 'newTab') {
      pageCounter += 1;
      const newPageVar = pageCounter === 2 ? 'page2' : `page${pageCounter}`;
      const currentPage = pageStack[pageStack.length - 1];
      emitTopLevel(step, stepBody(step, currentPage, newPageVar), currentPage);
      pageStack.push(newPageVar);
      continue;
    }
    if (step.type === 'closeTab') {
      if (pageStack.length <= 1) {
        throw new CompileError(step.id, `Step '${step.id}': closeTab cannot close the last remaining tab — at least one page must stay open`);
      }
      const currentPage = pageStack[pageStack.length - 1];
      emitTopLevel(step, stepBody(step, currentPage), currentPage);
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
      lines.push(...emitCallAction(step, action, `${pad}  `, dataset !== undefined, pageStack[pageStack.length - 1] as string, opts?.healingProbe === true));
      continue;
    }
    // P2 plugin fail-fast when the registry snapshot is available (otherwise
    // the workdir helper throws PLUGIN_NOT_FOUND at run time — never silent).
    if (typeof step.type === 'string' && PLUGIN_STEP_PATTERN.test(step.type)) {
      assertPluginStep(step, opts?.plugins);
    }
    const currentTop = pageStack[pageStack.length - 1] as string;
    emitTopLevel(step, stepBody(step, currentTop), currentTop);
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
  const fields = ['url', 'value', 'key', 'expected', 'pattern', 'body', 'headers', 'promptText', 'params'] as const;
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
  /** Observe mode: ms of Playwright launch slow-motion (0/undefined = off). */
  slowMoMs?: number;
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
  /**
   * P2 healing headroom: caps primary actions at this ms so a failing
   * locator cannot eat the whole test timeout before probes run. Only
   * emitted when set (flag-gated runs); P0 config stays byte-identical.
   */
  healingActionTimeoutMs?: number;
}

/** Playwright config for the isolated run: per-run context + custom reporter. */
export function compileConfig(opts: RunConfigOptions): string {
  const storageStateLine = opts.storageStateFile
    ? `    contextOptions: { storageState: ${esc(opts.storageStateFile)} }, // P1 auth context materialized per run`
    : `    contextOptions: { storageState: undefined }, // fresh context per run, never reused`;
  // NOTE: devices['Desktop Chrome'] pins viewport 1280x720 — an explicit
  // run/test viewport must be re-applied AFTER the spread, otherwise the
  // responsive override is silently ignored (screenshots stay 1280x720).
  const viewportLine = opts.viewport
    ? `, viewport: { width: ${opts.viewport.width}, height: ${opts.viewport.height} }`
    : ``;
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
    ...(typeof opts.healingActionTimeoutMs === 'number' && Number.isFinite(opts.healingActionTimeoutMs)
      ? [`    actionTimeout: ${Math.trunc(opts.healingActionTimeoutMs)}, // P2 healing: primary capped, probes keep headroom`]
      : []),
    ...(opts.slowMoMs ? [`    launchOptions: { slowMo: ${Math.trunc(opts.slowMoMs)} }, // observe mode`] : []),
    ...(opts.viewport ? [`    viewport: { width: ${opts.viewport.width}, height: ${opts.viewport.height} },`] : []),
    `    trace: ${esc(opts.trace)},`,
    `    screenshot: ${esc(opts.screenshot)},`,
    `    video: ${esc(opts.video)},`,
    storageStateLine,
    `  },`,
    `  projects: [{ name: ${esc(opts.runId)}, use: { ...devices['Desktop Chrome']${viewportLine} } }],`,
    `  reporter: [[${esc(opts.reporterPath)}, { runId: ${esc(opts.runId)} }]],`,
    `});`,
    ``,
  ].join('\n');
}
