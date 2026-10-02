/**
 * Step 1/8 — Validate test definition.
 * Pure function: never mutates the stored definition (03-test-model).
 */

import type { TestDefinition, TestStep } from './types.js';

export const SUPPORTED_STEP_TYPES: ReadonlySet<string> = new Set([
  // navigation
  'goto',
  'reload',
  'goBack',
  'goForward',
  // interaction
  'click',
  'doubleClick',
  'fill',
  'clear',
  'press',
  'check',
  'uncheck',
  'select',
  'hover',
  // wait
  'waitForElement',
  'waitForTimeout',
  'waitForURL',
  // assertions
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
  // utility
  'screenshot',
]);

const SUPPORTED_LOCATOR_STRATEGIES: ReadonlySet<string> = new Set([
  'role',
  'label',
  'placeholder',
  'testId',
  'text',
  'css',
  'xpath',
]);

const STEPS_REQUIRING_TARGET: ReadonlySet<string> = new Set([
  'click',
  'doubleClick',
  'fill',
  'clear',
  'check',
  'uncheck',
  'select',
  'hover',
  'waitForElement',
  'assertVisible',
  'assertHidden',
  'assertText',
  'assertContainsText',
  'assertValue',
  'assertEnabled',
  'assertDisabled',
  'assertChecked',
]);

export interface ValidationIssue {
  code: string;
  message: string;
  stepId?: string;
}

export class ValidationError extends Error {
  readonly code = 'TEST_DEFINITION_INVALID';
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(`Invalid test definition: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateStep(step: TestStep, index: number, issues: ValidationIssue[]): void {
  const where = `steps[${index}]`;
  if (!isRecord(step)) {
    issues.push({ code: 'STEP_NOT_OBJECT', message: `${where} must be an object` });
    return;
  }
  if (typeof step.id !== 'string' || step.id.length === 0) {
    issues.push({ code: 'STEP_ID_MISSING', message: `${where}.id is required`, stepId: String(step.id ?? '') });
  }
  if (typeof step.type !== 'string' || !SUPPORTED_STEP_TYPES.has(step.type)) {
    issues.push({
      code: 'STEP_TYPE_UNSUPPORTED',
      message: `${where}.type '${String(step.type)}' is not in the P0 step catalog`,
      stepId: typeof step.id === 'string' ? step.id : undefined,
    });
    return;
  }
  if (typeof step.enabled !== 'boolean') {
    issues.push({ code: 'STEP_ENABLED_INVALID', message: `${where}.enabled must be boolean`, stepId: step.id });
  }
  if (step.timeoutMs !== undefined && !(Number.isFinite(step.timeoutMs) && step.timeoutMs > 0)) {
    issues.push({ code: 'STEP_TIMEOUT_INVALID', message: `${where}.timeoutMs must be a positive number`, stepId: step.id });
  }
  if (STEPS_REQUIRING_TARGET.has(step.type)) {
    const primary = (step.target as { primary?: unknown } | undefined)?.primary;
    if (!isRecord(primary) || typeof primary.strategy !== 'string') {
      issues.push({ code: 'STEP_TARGET_MISSING', message: `${where} requires target.primary`, stepId: step.id });
    } else if (!SUPPORTED_LOCATOR_STRATEGIES.has(primary.strategy)) {
      issues.push({
        code: 'LOCATOR_STRATEGY_UNSUPPORTED',
        message: `${where}.target.primary.strategy '${primary.strategy}' is not supported`,
        stepId: step.id,
      });
    }
  }
  if (step.type === 'goto' && typeof step.url !== 'string') {
    issues.push({ code: 'STEP_URL_MISSING', message: `${where} of type 'goto' requires url`, stepId: step.id });
  }
  // SSRF/code-injection guard (defense-in-depth; the server re-checks resolved
  // URLs before launch): block non-http(s) schemes such as javascript:/data:/file:.
  // {{VAR}} templates and relative paths are allowed — they resolve server-side.
  for (const field of ['url', 'pattern', 'expected'] as const) {
    const v = (step as unknown as Record<string, unknown>)[field];
    if (typeof v === 'string') {
      const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(v.trim());
      if (scheme) {
        const proto = scheme[0].slice(0, -1).toLowerCase();
        if (proto !== 'http' && proto !== 'https') {
          issues.push({
            code: 'STEP_URL_SCHEME_BLOCKED',
            message: `${where}.${field} uses blocked scheme '${proto}:' (only http(s) allowed)`,
            stepId: step.id,
          });
        }
      }
    }
  }
  if (step.type === 'fill' && typeof step.value !== 'string') {
    issues.push({ code: 'STEP_VALUE_MISSING', message: `${where} of type 'fill' requires value`, stepId: step.id });
  }
  if (step.type === 'waitForTimeout' && !(Number.isFinite(step.milliseconds) && (step.milliseconds as number) >= 0)) {
    issues.push({
      code: 'STEP_WAIT_INVALID',
      message: `${where} of type 'waitForTimeout' requires milliseconds >= 0`,
      stepId: step.id,
    });
  }
}

/** Throw ValidationError when the definition is not runnable. Otherwise return silently. */
export function validateTestDefinition(def: TestDefinition): void {
  const issues: ValidationIssue[] = [];
  if (!isRecord(def)) {
    throw new ValidationError([{ code: 'DEFINITION_NOT_OBJECT', message: 'Test definition must be an object' }]);
  }
  if (def.schemaVersion !== '1.0') {
    issues.push({ code: 'SCHEMA_VERSION_UNSUPPORTED', message: `schemaVersion '${String(def.schemaVersion)}' is not supported (expected '1.0')` });
  }
  if (typeof def.id !== 'string' || def.id.length === 0) {
    issues.push({ code: 'TEST_ID_MISSING', message: 'definition.id is required' });
  }
  if (typeof def.projectId !== 'string' || def.projectId.length === 0) {
    issues.push({ code: 'PROJECT_ID_MISSING', message: 'definition.projectId is required' });
  }
  if (typeof def.name !== 'string' || def.name.length === 0) {
    issues.push({ code: 'TEST_NAME_MISSING', message: 'definition.name is required' });
  }
  if (def.browser !== 'chromium' && def.browser !== 'firefox' && def.browser !== 'webkit') {
    issues.push({ code: 'BROWSER_UNSUPPORTED', message: `browser '${String(def.browser)}' must be chromium|firefox|webkit` });
  }
  if (def.timeoutMs !== undefined && !(Number.isFinite(def.timeoutMs) && def.timeoutMs > 0)) {
    issues.push({ code: 'TEST_TIMEOUT_INVALID', message: 'definition.timeoutMs must be a positive number' });
  }
  if (!Array.isArray(def.steps) || def.steps.length === 0) {
    issues.push({ code: 'STEPS_EMPTY', message: 'definition.steps must be a non-empty array' });
  } else {
    const seen = new Set<string>();
    def.steps.forEach((step, index) => {
      validateStep(step, index, issues);
      if (isRecord(step) && typeof step.id === 'string') {
        if (seen.has(step.id)) {
          issues.push({ code: 'STEP_ID_DUPLICATE', message: `duplicate step id '${step.id}'`, stepId: step.id });
        }
        seen.add(step.id);
      }
    });
  }
  if (issues.length > 0) throw new ValidationError(issues);
}
