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
  // P1 reusable-action invocation (callee body inlines at compile time)
  'callAction',
  // P1 wave-2: files / tabs / dialogs / API (mirrors test-model P1_STEP_TYPES)
  'upload',
  'download',
  'newTab',
  'closeTab',
  'handleDialog',
  'apiRequest',
  // P2: visual regression (plugin:* steps match by prefix below)
  'visualCheck',
]);

/** P2 plugin step types are namespaced `plugin:<name>` (globally unique). */
export const PLUGIN_STEP_PATTERN = /^plugin:[A-Za-z0-9][A-Za-z0-9_.-]*$/;

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
  // P1 wave-2: upload always needs a file-input locator; download needs one
  // unless it carries a direct `url` (checked below).
  'upload',
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
  if (typeof step.type !== 'string' || (!SUPPORTED_STEP_TYPES.has(step.type) && !PLUGIN_STEP_PATTERN.test(step.type))) {
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
  if (step.type === 'callAction') {
    if (typeof step.actionId !== 'string' || step.actionId.length === 0) {
      issues.push({ code: 'STEP_ACTION_MISSING', message: `${where} of type 'callAction' requires actionId`, stepId: step.id });
    }
    if (step.arguments !== undefined) {
      const args = step.arguments as unknown;
      if (
        !isRecord(args) ||
        !Object.values(args).every((v) => typeof v === 'string')
      ) {
        issues.push({ code: 'STEP_ARGS_INVALID', message: `${where} of type 'callAction' requires arguments to be a record of strings`, stepId: step.id });
      }
    }
  }
  if (step.type === 'waitForTimeout' && !(Number.isFinite(step.milliseconds) && (step.milliseconds as number) >= 0)) {
    issues.push({
      code: 'STEP_WAIT_INVALID',
      message: `${where} of type 'waitForTimeout' requires milliseconds >= 0`,
      stepId: step.id,
    });
  }
  // ---- P1 wave-2 field checks (explicit failures, never silent skips) ----
  if (step.type === 'upload') {
    if (typeof step.fileId !== 'string' || step.fileId.length === 0) {
      issues.push({ code: 'STEP_FILE_MISSING', message: `${where} of type 'upload' requires fileId`, stepId: step.id });
    }
  }
  if (step.type === 'download') {
    if (step.target === undefined && step.url === undefined) {
      issues.push({ code: 'STEP_DOWNLOAD_SOURCE_MISSING', message: `${where} of type 'download' requires at least one of 'target' or 'url'`, stepId: step.id });
    }
    if (step.target !== undefined) {
      const primary = (step.target as { primary?: unknown } | undefined)?.primary;
      if (!isRecord(primary) || typeof (primary as Record<string, unknown>).strategy !== 'string') {
        issues.push({ code: 'STEP_TARGET_MISSING', message: `${where} requires target.primary`, stepId: step.id });
      } else if (!SUPPORTED_LOCATOR_STRATEGIES.has(String((primary as Record<string, unknown>).strategy))) {
        issues.push({
          code: 'LOCATOR_STRATEGY_UNSUPPORTED',
          message: `${where}.target.primary.strategy '${String((primary as Record<string, unknown>).strategy)}' is not supported`,
          stepId: step.id,
        });
      }
    }
    if (step.saveAs !== undefined && (typeof step.saveAs !== 'string' || step.saveAs.length === 0)) {
      issues.push({ code: 'STEP_SAVEAS_INVALID', message: `${where} of type 'download' requires saveAs to be a non-empty string`, stepId: step.id });
    }
  }
  if (step.type === 'handleDialog') {
    if (step.action !== 'accept' && step.action !== 'dismiss') {
      issues.push({ code: 'STEP_DIALOG_ACTION_INVALID', message: `${where} of type 'handleDialog' requires action 'accept'|'dismiss'`, stepId: step.id });
    }
    if (step.promptText !== undefined && typeof step.promptText !== 'string') {
      issues.push({ code: 'STEP_DIALOG_PROMPT_INVALID', message: `${where} of type 'handleDialog' requires promptText to be a string`, stepId: step.id });
    }
  }
  if (step.type === 'apiRequest') {
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    if (typeof step.method !== 'string' || !methods.includes(step.method)) {
      issues.push({ code: 'STEP_API_METHOD_INVALID', message: `${where} of type 'apiRequest' requires method ${methods.join('|')}`, stepId: step.id });
    }
    if (typeof step.url !== 'string' || step.url.length === 0) {
      issues.push({ code: 'STEP_URL_MISSING', message: `${where} of type 'apiRequest' requires url`, stepId: step.id });
    }
    if (step.headers !== undefined) {
      const h = step.headers as unknown;
      if (!isRecord(h) || !Object.values(h).every((v) => typeof v === 'string')) {
        issues.push({ code: 'STEP_API_HEADERS_INVALID', message: `${where} of type 'apiRequest' requires headers to be a record of strings`, stepId: step.id });
      }
    }
    if (step.body !== undefined && typeof step.body !== 'string') {
      issues.push({ code: 'STEP_API_BODY_INVALID', message: `${where} of type 'apiRequest' requires body to be a string`, stepId: step.id });
    }
    if (step.expectedStatus !== undefined && !(Number.isInteger(step.expectedStatus) && (step.expectedStatus as number) >= 100 && (step.expectedStatus as number) <= 599)) {
      issues.push({ code: 'STEP_API_STATUS_INVALID', message: `${where} of type 'apiRequest' requires expectedStatus 100-599`, stepId: step.id });
    }
    if (step.saveAs !== undefined && !(typeof step.saveAs === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(step.saveAs))) {
      issues.push({ code: 'STEP_API_SAVEAS_INVALID', message: `${where} of type 'apiRequest' requires saveAs to match /^[A-Za-z_][A-Za-z0-9_]*$/`, stepId: step.id });
    }
  }
  // ---- P2 field checks (explicit failures, never silent skips) ----
  if (step.type === 'visualCheck') {
    const rec = step as unknown as Record<string, unknown>;
    if (typeof step.name !== 'string' || step.name.length === 0 || step.name.length > 200) {
      issues.push({ code: 'STEP_VISUAL_NAME_MISSING', message: `${where} of type 'visualCheck' requires name (1-200 chars)`, stepId: step.id });
    }
    const threshold = rec['threshold'];
    if (threshold !== undefined && !(typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0 && threshold <= 1)) {
      issues.push({ code: 'STEP_VISUAL_THRESHOLD_INVALID', message: `${where} of type 'visualCheck' requires threshold in [0, 1]`, stepId: step.id });
    }
    if (step.target !== undefined) {
      const primary = (step.target as { primary?: unknown } | undefined)?.primary;
      if (!isRecord(primary) || typeof (primary as Record<string, unknown>).strategy !== 'string') {
        issues.push({ code: 'STEP_TARGET_MISSING', message: `${where} requires target.primary`, stepId: step.id });
      } else if (!SUPPORTED_LOCATOR_STRATEGIES.has(String((primary as Record<string, unknown>).strategy))) {
        issues.push({
          code: 'LOCATOR_STRATEGY_UNSUPPORTED',
          message: `${where}.target.primary.strategy '${String((primary as Record<string, unknown>).strategy)}' is not supported`,
          stepId: step.id,
        });
      }
    }
  }
  if (typeof step.type === 'string' && PLUGIN_STEP_PATTERN.test(step.type)) {
    const rec = step as unknown as Record<string, unknown>;
    const params = rec['params'];
    if (params !== undefined) {
      if (!isRecord(params) || !Object.values(params).every((v) => typeof v === 'string')) {
        issues.push({ code: 'STEP_PLUGIN_PARAMS_INVALID', message: `${where} of type '${step.type}' requires params to be a record of strings`, stepId: step.id });
      }
    }
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
