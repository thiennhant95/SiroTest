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
import {
  compileValueExpression,
  DATASET_SECRET_NOTE,
  hasRowReference,
  hasVariable,
  stringLiteral,
} from './variables';

/** Re-exported so consumers/tests can import the emitted note from the compiler entry. */
export { DATASET_SECRET_NOTE };

/** Bump together with package.json version; part of the determinism contract. */
export const COMPILER_VERSION = '0.1.0';

/** P1 — one named table of rows for data-driven runs (embedded, capped). */
export interface DataSet {
  id: string;
  name: string;
  rows: Record<string, string>[];
}

/** Maximum embedded dataset rows per table (mirrors test-model MAX_DATASET_ROWS). */
export const MAX_DATASET_ROWS = 500;

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
  /** P1 — embedded data tables; a run selects one via compile options. */
  datasets?: DataSet[];
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
  constructor(stepId: string, stepType: string, detail?: string) {
    super(detail ?? `Unsupported step type "${stepType}" (step id "${stepId}")`);
    this.name = 'UnsupportedStepError';
    this.stepId = stepId;
    this.stepType = stepType;
  }
}

// ------------------------------------------------- P1 reusable actions ---

/**
 * P1 — a named parameter of a reusable action.
 * Mirrors `ActionParameter` in packages/test-model (kept local so this
 * package has no runtime dependency on test-model).
 */
export interface ActionParameter {
  name: string;
  description?: string;
  /** Used when the caller omits the argument. */
  default?: string;
  /** Secret params must be passed as `{{VARIABLE}}` refs — never literals. */
  secret?: boolean;
}

/**
 * P1 — reusable business action (project-scoped, stored in `actions` table).
 * Body steps are P0 steps only: nested `callAction` is rejected at compile
 * time with an explicit error (keeps inlining total and readable).
 */
export interface ReusableAction {
  schemaVersion: '1.0';
  id: string;
  projectId: string;
  name: string;
  description?: string;
  parameters: ActionParameter[];
  steps: TestStep[];
}

/** Lookup for `callAction` resolution: actionId -> ReusableAction. */
export type ActionsContext = Map<string, ReusableAction> | Record<string, ReusableAction>;

function lookupAction(actions: ActionsContext | undefined, actionId: string): ReusableAction | undefined {
  if (!actions) return undefined;
  if (actions instanceof Map) return actions.get(actionId);
  return Object.prototype.hasOwnProperty.call(actions, actionId)
    ? (actions as Record<string, ReusableAction>)[actionId]
    : undefined;
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
    case 'callAction': {
      const actionId = typeof r['actionId'] === 'string' ? (r['actionId'] as string) : '';
      return `Call action ${actionId}`;
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
    case 'callAction':
      throw new UnsupportedStepError(
        step.id,
        step.type,
        `Step "${step.id}" (callAction) can only be compiled with an actions context — pass { actions } to compileTest() so the callee body can be inlined explicitly`,
      );
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
 *
 * P1 data-driven runs: pass `{ datasetId }` to wrap the steps in a
 * deterministic iteration loop over `VV_DATASET_ROWS` (JSON rows injected by
 * the runner at run time). Without `datasetId` the output is byte-identical
 * to the P0 compiler. `{{row.NAME}}` references compile to a runtime row
 * lookup and REQUIRE a selected dataset — otherwise compilation fails
 * explicitly instead of emitting a spec that would crash on `row`.
 */
export interface CompileOptions {
  datasetId?: string;
  /**
   * P1 reusable-action lookup (actionId -> ReusableAction). When omitted
   * (P0 path), any `callAction` step fails compilation with an explicit
   * UnsupportedStepError — never silently skipped. Same definition +
   * same actions + same compiler version ⇒ byte-identical output.
   */
  actions?: ActionsContext;
}

/**
 * Emit one step as an `await test.step(...)` block at `baseIndent`
 * (e.g. `'  '` top-level, `'    '` inside an inlined action or dataset
 * loop). `body` lines are raw (unindented); timeout/continueOnFailure
 * are honoured. Produces byte-identical output to the pre-P1 inline
 * emission for the P0 path.
 */
function emitTestStepBlock(
  step: TestStep,
  titleExpr: string,
  body: string[],
  baseIndent: string,
): string[] {
  const timeoutOpt =
    typeof step.timeoutMs === 'number' && Number.isFinite(step.timeoutMs)
      ? `, { timeout: ${Math.trunc(step.timeoutMs)} }`
      : '';
  const inner = `${baseIndent}  `;
  let lines = body.map((line) => `${inner}${line}`);
  if (step.continueOnFailure === true) {
    lines = [
      `${inner}try {`,
      ...body.map((line) => `${inner}  ${line}`),
      `${inner}} catch {`,
      `${inner}  // continueOnFailure: step ${step.id} failed, continuing.`,
      `${inner}}`,
    ];
  }
  return [
    `${baseIndent}await test.step(${titleExpr}, async () => {`,
    ...lines,
    `${baseIndent}}${timeoutOpt});`,
  ];
}

/** Step title expression, with the dataset iteration suffix when looped. */
function stepTitleExpr(step: TestStep, title: string, dataset: boolean): string {
  if (!dataset) return stringLiteral(title);
  void step;
  return `\`${escapeTemplateText(title)} #\${_vvIteration + 1}\``;
}

const ACTION_PARAM_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Resolve caller arguments against the callee parameter list:
 * caller value → param default → explicit failure when a required
 * argument is missing. Secret params (and secret defaults) must be
 * `{{VARIABLE}}` references so plaintext never reaches generated code.
 */
function resolveActionArguments(caller: TestStep, action: ReusableAction): Record<string, string> {
  const rawArgs = asRecord(caller)['arguments'];
  const callerArgs: Record<string, unknown> =
    rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
  for (const key of Object.keys(callerArgs)) {
    if (!action.parameters.some((p) => p.name === key)) {
      throw new UnsupportedStepError(
        caller.id,
        'callAction',
        `Step "${caller.id}" (callAction) passes unknown argument "${key}" for action "${action.name}" (${action.id})`,
      );
    }
  }
  const resolved: Record<string, string> = {};
  for (const param of action.parameters) {
    const given = callerArgs[param.name];
    if (typeof given === 'string') {
      if (param.secret === true && !hasVariable(given)) {
        throw new InvalidDefinitionError(
          `Step "${caller.id}" (callAction): secret parameter "${param.name}" of action "${action.name}" must be passed as a {{VARIABLE}} reference so the secret is resolved at run time, never inlined`,
        );
      }
      resolved[param.name] = given;
    } else if (given !== undefined) {
      throw new InvalidDefinitionError(
        `Step "${caller.id}" (callAction): argument "${param.name}" must be a string`,
      );
    } else if (param.default !== undefined) {
      if (param.secret === true && !hasVariable(param.default)) {
        throw new InvalidDefinitionError(
          `Step "${caller.id}" (callAction): secret parameter "${param.name}" of action "${action.name}" has a plaintext default — defaults for secret params must be {{VARIABLE}} references`,
        );
      }
      resolved[param.name] = param.default;
    } else {
      throw new UnsupportedStepError(
        caller.id,
        'callAction',
        `Step "${caller.id}" (callAction) is missing required argument "${param.name}" for action "${action.name}" (${action.id}) and the parameter has no default`,
      );
    }
  }
  return resolved;
}

function substituteParamsInString(value: string, args: Record<string, string>): string {
  ACTION_PARAM_PATTERN.lastIndex = 0;
  return value.replace(ACTION_PARAM_PATTERN, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(args, name) ? args[name] : m,
  );
}

/**
 * Deep-clone a body step while interpolating `{{param}}` placeholders with
 * resolved argument values. Placeholders that are NOT action params are
 * left intact — they compile to normal `process.env.*` / `row[...]` lookups.
 */
function interpolateActionStep(step: TestStep, args: Record<string, string>): TestStep {
  const clone = JSON.parse(JSON.stringify(step)) as TestStep;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return substituteParamsInString(node, args);
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

/**
 * Emit a `callAction` step: resolve the callee, resolve arguments, and
 * inline the interpolated body steps inside
 * `test.step('<caller name or action name>', ...)` — readable and
 * deterministic. Each body step keeps its own name/timeoutMs/
 * continueOnFailure; the caller step contributes the outer title/timeout/
 * continueOnFailure.
 */
function emitCallActionBlock(
  caller: TestStep,
  action: ReusableAction,
  baseIndent: string,
  dataset: boolean,
): string[] {
  const args = resolveActionArguments(caller, action);
  const title = caller.name ?? `Call ${action.name}`;
  const timeoutOpt =
    typeof caller.timeoutMs === 'number' && Number.isFinite(caller.timeoutMs)
      ? `, { timeout: ${Math.trunc(caller.timeoutMs)} }`
      : '';
  const innerIndent = `${baseIndent}  `;
  const inner: string[] = [];
  action.steps.forEach((bodyStep, index) => {
    if (bodyStep.type === 'callAction') {
      throw new UnsupportedStepError(
        caller.id,
        'callAction',
        `Step "${caller.id}" (callAction) cannot inline action "${action.name}" (${action.id}): nested callAction (body step "${bodyStep.id}") is rejected — action bodies must be P0 steps`,
      );
    }
    if (index > 0) inner.push('');
    if (bodyStep.enabled === false) {
      inner.push(`${innerIndent}// skipped disabled step ${bodyStep.id} (${bodyStep.type})`);
      return;
    }
    const interpolated = interpolateActionStep(bodyStep, args);
    inner.push(
      ...emitTestStepBlock(
        interpolated,
        stepTitleExpr(interpolated, interpolated.name ?? defaultStepName(interpolated), dataset),
        compileStepBody(interpolated),
        innerIndent,
      ),
    );
  });
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
    `${baseIndent}await test.step(${stepTitleExpr(caller, title, dataset)}, async () => {`,
    ...body,
    `${baseIndent}}${timeoutOpt});`,
  ];
}

export function compileTest(def: TestDefinition, opts?: CompileOptions): string {
  validateDefinition(def);
  const dataset = resolveDataset(def, opts?.datasetId);
  if (!dataset) assertNoRowReferences(def);

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

  // Extra indentation level inside the dataset loop (0 for P0 output).
  const pad = dataset ? '  ' : '';
  if (dataset) {
    out.push(`  // Data-driven: dataset ${stringLiteral(dataset.name)} (${dataset.id}) — rows come from VV_DATASET_ROWS.`);
    out.push(`  // ${DATASET_SECRET_NOTE}`);
    out.push(`  const VV_ROWS: Array<Record<string, string>> = JSON.parse(process.env.VV_DATASET_ROWS ?? '[]');`);
    out.push(`  for (let _vvIteration = 0; _vvIteration < (VV_ROWS.length ? VV_ROWS.length : 1); _vvIteration++) {`);
    out.push(`    const row: Record<string, string> = VV_ROWS[_vvIteration] ?? {};`);
  }

  def.steps.forEach((step, index) => {
    if (index > 0) out.push('');
    if (step.enabled === false) {
      out.push(`${pad}  // skipped disabled step ${step.id} (${step.type})`);
      return;
    }
    if (step.type === 'callAction') {
      const actionId = asRecord(step)['actionId'];
      const action =
        typeof actionId === 'string' ? lookupAction(opts?.actions, actionId) : undefined;
      if (!action) {
        throw new UnsupportedStepError(
          step.id,
          'callAction',
          typeof actionId === 'string' && actionId.length > 0
            ? `Step "${step.id}" (callAction) references unknown action "${actionId}" — pass it via compileTest(def, { actions })`
            : `Step "${step.id}" (callAction) is missing required field "actionId"`,
        );
      }
      out.push(...emitCallActionBlock(step, action, `${pad}  `, dataset !== undefined));
      return;
    }
    out.push(
      ...emitTestStepBlock(
        step,
        stepTitleExpr(step, step.name ?? defaultStepName(step), dataset !== undefined),
        compileStepBody(step),
        `${pad}  `,
      ),
    );
  });

  if (dataset) out.push('  }');
  out.push('});');
  out.push('');
  return out.join('\n');
}

function sanitizeComment(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\*\//g, '* /').slice(0, 500);
}

/** Escape literal text for embedding inside a template literal (step titles). */
function escapeTemplateText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * Resolve the selected dataset for a data-driven compile. `undefined`
 * datasetId means "plain P0 run" (no loop). An unknown id fails explicitly.
 */
export function resolveDataset(def: TestDefinition, datasetId?: string): DataSet | undefined {
  if (datasetId === undefined) return undefined;
  const datasets = Array.isArray(def.datasets) ? def.datasets : [];
  const found = datasets.find((d) => d.id === datasetId);
  if (!found) {
    throw new InvalidDefinitionError(
      `Unknown datasetId "${datasetId}" (test has ${datasets.length} dataset(s)) — select an existing dataset or run without one`,
    );
  }
  return found;
}

/**
 * String fields that `compileStepBody` interpolates via compileValueExpression
 * (same set the runner mirror uses). `{{row.*}}` anywhere else (locators,
 * names) is inert P0 text and must NOT force dataset mode.
 */
const INTERPOLATED_FIELDS = ['url', 'value', 'key', 'expected', 'pattern'] as const;

function collectInterpolatedStrings(step: TestStep): string[] {
  const rec = step as Record<string, unknown>;
  const found: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (hasRowReference(v)) found.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v && typeof v === 'object') {
      for (const val of Object.values(v as Record<string, unknown>)) walk(val);
    }
  };
  for (const field of INTERPOLATED_FIELDS) walk(rec[field]);
  return found;
}

/**
 * `{{row.NAME}}` compiles to a `row[...]` lookup that only exists inside the
 * dataset loop. Without a selected dataset there is no `row` binding, so fail
 * explicitly (never emit a spec that ReferenceErrors at run time).
 *
 * P1 actions: `callAction` arguments interpolate into body-step value
 * fields, so `{{row.*}}` inside `arguments` is scanned too (it would
 * otherwise compile to a dangling `row` lookup inside the inlined body).
 */
function assertNoRowReferences(def: TestDefinition): void {
  for (const step of def.steps) {
    if (step.enabled === false) continue;
    const hits = collectInterpolatedStrings(step);
    if (step.type === 'callAction') {
      const args = asRecord(step)['arguments'];
      if (args && typeof args === 'object' && !Array.isArray(args)) {
        for (const v of Object.values(args as Record<string, unknown>)) {
          if (typeof v === 'string' && hasRowReference(v)) {
            hits.push(v);
            break;
          }
        }
      }
    }
    if (hits.length > 0) {
      throw new InvalidDefinitionError(
        `Step "${step.id}" uses ${hits[0]} but no dataset is selected — pass { datasetId } to compileTest or remove the {{row.*}} reference`,
      );
    }
  }
}
