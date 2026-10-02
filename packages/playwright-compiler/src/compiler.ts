/**
 * P0 compiler: validated `TestDefinition` -> deterministic TypeScript
 * using upstream `@playwright/test`.
 *
 * Guarantees (per 06-compiler/playwright-compiler.md):
 * - Pure/deterministic for same definition + compiler version.
 * - All generated strings escaped safely (single-quoted literals).
 * - Secret values never inlined (variables compile to `process.env.*`).
 * - Step names preserved via `test.step()` for reporting.
 * - Readable output, not minified.
 * - Unsupported steps fail compilation with an explicit error; never skipped.
 */
import {
  describeLocator,
  locatorToExpression,
  type LocatorSpec,
} from './locatorToExpression';
import { compileValueExpression, hasVariable, stringLiteral } from './variables';

/** Bump together with package.json version; part of the determinism contract. */
export const COMPILER_VERSION = '0.1.0';

export interface TestDefinition {
  schemaVersion: '1.0';
  id: string;
  projectId: string;
  name: string;
  description?: string;
  browser: 'chromium' | 'firefox' | 'webkit';
  baseUrl?: string;
  viewport?: { width: number; height: number };
  timeoutMs?: number;
  tags?: string[];
  variables?: Record<string, string>;
  steps: TestStep[];
}

export interface TestStep {
  id: string;
  type: string;
  name?: string;
  enabled: boolean;
  timeoutMs?: number;
  continueOnFailure?: boolean;
  [field: string]: unknown;
}

export class InvalidDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDefinitionError';
  }
}

export class UnsupportedStepError extends Error {
  readonly stepId: string;
  readonly stepType: string;
  constructor(stepId: string, stepType: string) {
    super(`Unsupported step type "${stepType}" (step id "${stepId}")`);
    this.name = 'UnsupportedStepError';
    this.stepId = stepId;
    this.stepType = stepType;
  }
}

/** Every step type the P0 compiler accepts (03-test-model/step-catalog.md). */
export const SUPPORTED_STEP_TYPES: readonly string[] = [
  'goto',
  'reload',
  'goBack',
  'goForward',
  'click',
  'doubleClick',
  'fill',
  'clear',
  'press',
  'check',
  'uncheck',
  'select',
  'hover',
  'waitForElement',
  'waitForTimeout',
  'waitForURL',
  'assertVisible',
  'assertHidden',
  'assertText',
  'assertContainsText',
  'assertValue',
  'assertURL',
  'assertTitle',
  'assertEnabled',
  'assertDisabled',
  'assertChecked',
  'screenshot',
];

function asRecord(step: TestStep): Record<string, unknown> {
  return step as Record<string, unknown>;
}

function requiredString(step: TestStep, field: string): string {
  const v = asRecord(step)[field];
  if (typeof v !== 'string' || v.length === 0) {
    throw new InvalidDefinitionError(
      `Step "${step.id}" (${step.type}): field "${field}" must be a non-empty string`,
    );
  }
  return v;
}

function optionalString(step: TestStep, ...fields: string[]): string | undefined {
  for (const f of fields) {
    const v = asRecord(step)[f];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function requiredNumber(step: TestStep, ...fields: string[]): number {
  for (const f of fields) {
    const v = asRecord(step)[f];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  throw new InvalidDefinitionError(
    `Step "${step.id}" (${step.type}): one of [${fields.join(', ')}] must be a finite number`,
  );
}

function requiredTarget(step: TestStep): LocatorSpec {
  const v = asRecord(step)['target'] as LocatorSpec | undefined;
  if (!v || typeof v !== 'object' || !v.primary) {
    throw new InvalidDefinitionError(
      `Step "${step.id}" (${step.type}): field "target.primary" is required`,
    );
  }
  return v;
}

/** Deterministic fallback title when a step carries no explicit `name`. */
export function defaultStepName(step: TestStep): string {
  const r = asRecord(step);
  const targetDesc = (() => {
    try {
      const t = r['target'] as LocatorSpec | undefined;
      return t ? describeLocator(t) : '';
    } catch {
      return '';
    }
  })();
  const withTarget = (verb: string) => (targetDesc ? `${verb} ${targetDesc}` : verb);
  switch (step.type) {
    case 'goto':
      return `Navigate to ${String(r['url'] ?? '')}`;
    case 'reload':
      return 'Reload page';
    case 'goBack':
      return 'Go back';
    case 'goForward':
      return 'Go forward';
    case 'click':
      return withTarget('Click');
    case 'doubleClick':
      return withTarget('Double-click');
    case 'fill':
      return withTarget('Fill');
    case 'clear':
      return withTarget('Clear');
    case 'press': {
      const key = typeof r['key'] === 'string' ? (r['key'] as string) : '';
      return targetDesc ? `Press ${key} on ${targetDesc}` : `Press ${key}`;
    }
    case 'check':
      return withTarget('Check');
    case 'uncheck':
      return withTarget('Uncheck');
    case 'select':
      return withTarget('Select option in');
    case 'hover':
      return withTarget('Hover');
    case 'waitForElement':
      return withTarget('Wait for');
    case 'waitForTimeout':
      return `Wait ${String(r['milliseconds'] ?? r['ms'] ?? '')}ms`;
    case 'waitForURL':
      return `Wait for URL ${String(r['url'] ?? r['pattern'] ?? r['expected'] ?? '')}`;
    case 'assertVisible':
      return targetDesc ? `Verify ${targetDesc}` : 'Verify visible';
    case 'assertHidden':
      return withTarget('Verify hidden');
    case 'assertText':
      return withTarget('Verify text');
    case 'assertContainsText':
      return withTarget('Verify contains text');
    case 'assertValue':
      return withTarget('Verify value');
    case 'assertURL':
      return `Verify URL ${String(r['expected'] ?? r['url'] ?? r['pattern'] ?? '')}`;
    case 'assertTitle':
      return `Verify title ${String(r['expected'] ?? r['title'] ?? '')}`;
    case 'assertEnabled':
      return withTarget('Verify enabled');
    case 'assertDisabled':
      return withTarget('Verify disabled');
    case 'assertChecked':
      return withTarget('Verify checked');
    case 'screenshot': {
      const n = typeof r['name'] === 'string' && r['name'] ? (r['name'] as string) : step.id;
      return `Screenshot ${n}`;
    }
    default:
      return `${step.type} ${step.id}`;
  }
}

/**
 * Compile one ENABLED step into `test.step()` body lines (without indentation).
 * Throws UnsupportedStepError for unknown types, InvalidDefinitionError for
 * missing/invalid fields.
 */
export function compileStepBody(step: TestStep): string[] {
  switch (step.type) {
    case 'goto': {
      const url = requiredString(step, 'url');
      return [`await page.goto(${compileValueExpression(url)});`];
    }
    case 'reload':
      return ['await page.reload();'];
    case 'goBack':
      return ['await page.goBack();'];
    case 'goForward':
      return ['await page.goForward();'];
    case 'click':
      return [`await ${locatorToExpression(requiredTarget(step))}.click();`];
    case 'doubleClick':
      return [`await ${locatorToExpression(requiredTarget(step))}.dblclick();`];
    case 'fill': {
      const value = requiredString(step, 'value');
      // Security (11-security/security.md): a sensitive literal must be a
      // {{VARIABLE}} reference resolved at run time — never inlined into code.
      if ((step as Record<string, unknown>)['sensitive'] === true && !hasVariable(value)) {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (fill): sensitive fill value must be a {{VARIABLE}} reference so the secret is resolved at run time, never inlined`,
        );
      }
      return [
        `await ${locatorToExpression(requiredTarget(step))}.fill(${compileValueExpression(value)});`,
      ];
    }
    case 'clear':
      // `.clear()` is the canonical Playwright clear semantic; the single
      // spelling is shared with apps/runner compile.ts and web preview.
      return [`await ${locatorToExpression(requiredTarget(step))}.clear();`];
    case 'press': {
      const key = requiredString(step, 'key');
      const target = asRecord(step)['target'] as LocatorSpec | undefined;
      if (target) {
        return [
          `await ${locatorToExpression(target)}.press(${compileValueExpression(key)});`,
        ];
      }
      return [`await page.keyboard.press(${compileValueExpression(key)});`];
    }
    case 'check':
      return [`await ${locatorToExpression(requiredTarget(step))}.check();`];
    case 'uncheck':
      return [`await ${locatorToExpression(requiredTarget(step))}.uncheck();`];
    case 'select': {
      const raw = asRecord(step)['value'];
      if (raw === undefined || raw === null) {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (select): field "value" is required`,
        );
      }
      const option =
        typeof raw === 'string'
          ? compileValueExpression(raw)
          : compileSelectOption(step, raw);
      return [`await ${locatorToExpression(requiredTarget(step))}.selectOption(${option});`];
    }
    case 'hover':
      return [`await ${locatorToExpression(requiredTarget(step))}.hover();`];
    case 'waitForElement': {
      const state = asRecord(step)['state'];
      const allowed = ['visible', 'hidden', 'attached', 'detached'];
      if (state !== undefined && (typeof state !== 'string' || !allowed.includes(state))) {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (waitForElement): "state" must be one of ${allowed.join(', ')}`,
        );
      }
      const opts = typeof state === 'string' ? `{ state: ${stringLiteral(state)} }` : '';
      return [`await ${locatorToExpression(requiredTarget(step))}.waitFor(${opts});`];
    }
    case 'waitForTimeout': {
      const ms = requiredNumber(step, 'milliseconds', 'ms');
      return [
        '// WARNING: fixed wait is discouraged; prefer waitForElement/waitForURL.',
        `await page.waitForTimeout(${Math.trunc(ms)});`,
      ];
    }
    case 'waitForURL': {
      const url = optionalString(step, 'url', 'pattern', 'expected');
      if (!url) {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (waitForURL): one of "url"/"pattern"/"expected" is required`,
        );
      }
      return [`await page.waitForURL(${compileValueExpression(url)});`];
    }
    case 'assertVisible':
      return [`await expect(${locatorToExpression(requiredTarget(step))}).toBeVisible();`];
    case 'assertHidden':
      return [`await expect(${locatorToExpression(requiredTarget(step))}).toBeHidden();`];
    case 'assertText': {
      const expected = optionalString(step, 'expected', 'value', 'text');
      if (expected === undefined) {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (assertText): field "expected" is required`,
        );
      }
      return [
        `await expect(${locatorToExpression(requiredTarget(step))}).toHaveText(${compileValueExpression(expected)});`,
      ];
    }
    case 'assertContainsText': {
      const expected = optionalString(step, 'expected', 'value', 'text');
      if (expected === undefined) {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (assertContainsText): field "expected" is required`,
        );
      }
      return [
        `await expect(${locatorToExpression(requiredTarget(step))}).toContainText(${compileValueExpression(expected)});`,
      ];
    }
    case 'assertValue': {
      const expected = optionalString(step, 'expected', 'value');
      if (expected === undefined) {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (assertValue): field "expected" is required`,
        );
      }
      return [
        `await expect(${locatorToExpression(requiredTarget(step))}).toHaveValue(${compileValueExpression(expected)});`,
      ];
    }
    case 'assertURL': {
      const expected = optionalString(step, 'expected', 'url', 'pattern');
      if (!expected) {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (assertURL): one of "expected"/"url"/"pattern" is required`,
        );
      }
      return [`await expect(page).toHaveURL(${compileValueExpression(expected)});`];
    }
    case 'assertTitle': {
      const expected = optionalString(step, 'expected', 'title');
      if (!expected) {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (assertTitle): one of "expected"/"title" is required`,
        );
      }
      return [`await expect(page).toHaveTitle(${compileValueExpression(expected)});`];
    }
    case 'assertEnabled':
      return [`await expect(${locatorToExpression(requiredTarget(step))}).toBeEnabled();`];
    case 'assertDisabled':
      return [`await expect(${locatorToExpression(requiredTarget(step))}).toBeDisabled();`];
    case 'assertChecked':
      return [`await expect(${locatorToExpression(requiredTarget(step))}).toBeChecked();`];
    case 'screenshot': {
      const r = asRecord(step);
      const name =
        typeof r['name'] === 'string' && r['name'] ? (r['name'] as string) : step.id;
      const opts: string[] = [`path: ${stringLiteral(`screenshots/${name}.png`)}`];
      if (r['fullPage'] === true) opts.push('fullPage: true');
      return [`await page.screenshot({ ${opts.join(', ')} });`];
    }
    default:
      throw new UnsupportedStepError(step.id, step.type);
  }
}

function compileSelectOption(step: TestStep, raw: unknown): string {
  if (Array.isArray(raw)) {
    return `[${raw.map((v) => compileSelectOption(step, v)).join(', ')}]`;
  }
  if (typeof raw === 'object' && raw !== null) {
    const o = raw as Record<string, unknown>;
    const fields: string[] = [];
    if (typeof o['value'] === 'string') fields.push(`value: ${compileValueExpression(o['value'])}`);
    if (typeof o['label'] === 'string') fields.push(`label: ${compileValueExpression(o['label'])}`);
    if (typeof o['index'] === 'number') fields.push(`index: ${Math.trunc(o['index'])}`);
    if (fields.length === 0) {
      throw new InvalidDefinitionError(
        `Step "${step.id}" (select): option object needs "value", "label" or "index"`,
      );
    }
    return `{ ${fields.join(', ')} }`;
  }
  throw new InvalidDefinitionError(
    `Step "${step.id}" (select): field "value" must be a string, option object or array`,
  );
}

function validateDefinition(def: TestDefinition): void {
  if (!def || typeof def !== 'object') throw new InvalidDefinitionError('TestDefinition must be an object');
  if (def.schemaVersion !== '1.0') {
    throw new InvalidDefinitionError(
      `Unsupported schemaVersion "${String((def as unknown as Record<string, unknown>)['schemaVersion'])}" (expected "1.0")`,
    );
  }
  if (!def.id || !def.name || !def.projectId) {
    throw new InvalidDefinitionError('TestDefinition requires "id", "projectId" and "name"');
  }
  if (!Array.isArray(def.steps)) throw new InvalidDefinitionError('TestDefinition requires "steps" array');
  for (const s of def.steps) {
    if (!s || typeof s !== 'object' || !s.id || !s.type) {
      throw new InvalidDefinitionError('Every step requires "id" and "type"');
    }
  }
}

/**
 * Compile a full TestDefinition into a deterministic `.spec.ts` source string.
 * Same input JSON + same COMPILER_VERSION always yields byte-identical output.
 */
export function compileTest(def: TestDefinition): string {
  validateDefinition(def);

  const out: string[] = [];
  out.push(`// Generated by @vietvang/playwright-compiler v${COMPILER_VERSION} - do not edit.`);
  out.push(`// Test: ${def.id} | schema: ${def.schemaVersion}`);
  out.push(`import { test, expect } from '@playwright/test';`);
  out.push('');
  if (def.viewport) {
    out.push(
      `test.use({ viewport: { width: ${Math.trunc(def.viewport.width)}, height: ${Math.trunc(def.viewport.height)} } });`,
    );
    out.push('');
  }
  if (def.description) {
    out.push(`// ${sanitizeComment(def.description)}`);
  }
  if (def.timeoutMs !== undefined) {
    out.push(
      `// Requested test timeout: ${Math.trunc(def.timeoutMs)}ms (apply via test.setTimeout in a suite; per-step timeouts are emitted below).`,
    );
  }
  out.push(`test(${stringLiteral(def.name)}, async ({ page }) => {`);

  def.steps.forEach((step, index) => {
    if (index > 0) out.push('');
    if (step.enabled === false) {
      out.push(`  // skipped disabled step ${step.id} (${step.type})`);
      return;
    }
    const title = step.name ?? defaultStepName(step);
    const timeoutOpt =
      typeof step.timeoutMs === 'number' && Number.isFinite(step.timeoutMs)
        ? `, { timeout: ${Math.trunc(step.timeoutMs)} }`
        : '';
    const rawBody = compileStepBody(step);
    let body = rawBody.map((line) => `    ${line}`);
    if (step.continueOnFailure === true) {
      body = [
        '    try {',
        ...rawBody.map((line) => `      ${line}`),
        '    } catch {',
        `      // continueOnFailure: step ${step.id} failed, continuing.`,
        '    }',
      ];
    }
    out.push(`  await test.step(${stringLiteral(title)}, async () => {`);
    out.push(...body);
    out.push(`  }${timeoutOpt});`);
  });

  out.push('});');
  out.push('');
  return out.join('\n');
}

function sanitizeComment(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\*\//g, '* /').slice(0, 500);
}
