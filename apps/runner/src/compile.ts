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

import type { LocatorCandidate, TestDefinition, TestStep } from './types.js';
import { findTemplateVars } from './env.js';

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
 * Compile a `{{VAR}}`-templated string to a TS expression reading
 * process.env at run time. Pure literals are inlined (escaped).
 */
function templateExpr(template: string, field: string, stepId: string): string {
  const vars = findTemplateVars(template);
  if (vars.length === 0) return esc(template);
  const parts: string[] = [];
  const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    if (m.index > last) parts.push(esc(template.slice(last, m.index)));
    parts.push(`(process.env[${esc(m[1])}] ?? '')`);
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push(esc(template.slice(last)));
  if (parts.length === 0) {
    throw new CompileError(stepId, `Step '${stepId}': field '${field}' has an empty template`);
  }
  return parts.join(' + ');
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
    default:
      throw new CompileError(step.id, `Step '${step.id}': unsupported step type '${step.type}' — failing compilation, never silently skipping`);
  }
}

/** Deterministic spec source for one enabled-steps test. Disabled steps are omitted (reporter marks them skipped). */
export function compileSpec(test: TestDefinition, opts?: { testTimeoutMs?: number }): string {
  const enabled = test.steps.filter((s) => s.enabled);
  const lines: string[] = [
    `// Generated by runner compiler ${RUNNER_COMPILER_VERSION} — do not edit.`,
    `// Test: ${test.name} (${test.id})`,
    `import { test, expect } from '@playwright/test';`,
    ``,
    `test(${esc(test.name)}, async ({ page }) => {`,
  ];
  if (opts?.testTimeoutMs) lines.push(`  test.setTimeout(${opts.testTimeoutMs});`);
  for (const step of enabled) {
    const title = `[${step.id}] ${step.name ?? step.type}`;
    lines.push(`  await test.step(${esc(title)}, async () => {`);
    lines.push(`    ${stepBody(step)}`);
    if (step.timeoutMs) lines.push(`  }, { timeout: ${step.timeoutMs} });`);
    else lines.push(`  });`);
  }
  lines.push(`});`, ``);
  return lines.join('\n');
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
