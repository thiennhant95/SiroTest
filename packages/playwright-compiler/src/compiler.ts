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
  compileUrlMatcher,
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

/**
 * P1 wave-2 step types (shapes in packages/test-model/src/types.ts).
 * The P0 `SUPPORTED_STEP_TYPES` list above is kept frozen so P0 goldens and
 * coverage assertions stay byte-identical; wave-2 support is additive and
 * gated on the compiler paths below (never silently skipped).
 */
export const P1_WAVE2_STEP_TYPES: readonly string[] = [
  'upload',
  'download',
  'newTab',
  'closeTab',
  'handleDialog',
  'apiRequest',
];

/** Env key carrying the fileId -> absolute-path map for `upload` steps. */
export const FILE_PATHS_ENV = 'VV_FILE_PATHS';
/** Legacy alias also honoured at run time (runner injects both). */
export const FILE_PATHS_ENV_ALIAS = 'FILE_PATHS';

/**
 * P2 — visual regression + plugin steps (additive; P0 output stays
 * byte-identical when no P2 step is present).
 *
 * - `visualCheck` screenshots an element (or the viewport) into the run
 *   artifact dir and compares it against a server-injected baseline via the
 *   isolated-workdir helper `./vv-visual-compare.cjs` (materialized by the
 *   runner; pure self-written PNG codec, no new dependency).
 * - `plugin:<name>` steps call `./vv-plugins.cjs` (materialized by the
 *   runner from the trusted `PLUGINS_DIR` registry); an unregistered type
 *   fails at run time with `PLUGIN_NOT_FOUND`, or at compile time when the
 *   registry snapshot is passed via `CompileOptions.plugins`.
 */
export const P2_STEP_TYPES: readonly string[] = ['visualCheck'];

/** Step types must be globally unique and namespaced: `plugin:<name>`. */
export const PLUGIN_TYPE_PATTERN = /^plugin:[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Env key carrying the baseline map (JSON name -> absolute path). */
export const BASELINES_ENV = 'VV_BASELINES';
/** When `'1'`, visual checks capture the actual as the new baseline (pass). */
export const UPDATE_BASELINES_ENV = 'VV_UPDATE_BASELINES';
/** Allowed fraction of differing pixels when `threshold` is omitted. */
export const VISUAL_DEFAULT_THRESHOLD = 0.05;

function asRecord(step: TestStep): Record<string, unknown> {
  return step as Record<string, unknown>;
}

/**
 * Step timeout also governs expect() polling (test.step timeout alone does
 * not — expect defaults to 5s). Mirror of the runner compiler helper.
 */
function expectTimeout(step: TestStep): string {
  const ms = asRecord(step)['timeoutMs'];
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? `{ timeout: ${Math.trunc(ms)} }` : '';
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
    case 'visualCheck': {
      const n = typeof r['name'] === 'string' && r['name'] ? (r['name'] as string) : step.id;
      return `Visual check ${n}`;
    }
    case 'callAction': {
      const actionId = typeof r['actionId'] === 'string' ? (r['actionId'] as string) : '';
      return `Call action ${actionId}`;
    }
    case 'upload':
      return withTarget('Upload');
    case 'download': {
      const saveAs = typeof r['saveAs'] === 'string' && r['saveAs'] ? (r['saveAs'] as string) : '';
      const url = typeof r['url'] === 'string' ? (r['url'] as string) : '';
      if (targetDesc) return `Download ${targetDesc}`;
      return saveAs ? `Download ${saveAs}` : url ? `Download ${url}` : 'Download';
    }
    case 'newTab': {
      const url = typeof r['url'] === 'string' && r['url'] ? (r['url'] as string) : '';
      return url ? `Open new tab ${url}` : 'Open new tab';
    }
    case 'closeTab':
      return 'Close tab';
    case 'handleDialog': {
      const action = typeof r['action'] === 'string' ? (r['action'] as string) : '';
      return action ? `Handle dialog ${action}` : 'Handle dialog';
    }
    case 'apiRequest': {
      const method = typeof r['method'] === 'string' ? (r['method'] as string) : '';
      const url = typeof r['url'] === 'string' ? (r['url'] as string) : '';
      return method && url ? `API ${method} ${url}` : method ? `API ${method}` : 'API request';
    }
    case 'mockRoute': {
      const mUrl = typeof r['url'] === 'string' ? (r['url'] as string) : '';
      return mUrl ? `Mock ${mUrl}` : 'Mock route';
    }
    default:
      return `${step.type} ${step.id}`;
  }
}

/**
 * Compile one ENABLED step into `test.step()` body lines (without indentation).
 * Throws UnsupportedStepError for unknown types, InvalidDefinitionError for
 * missing/invalid fields.
 *
 * P1 wave-2 semantics (shapes: packages/test-model/src/types.ts):
 * - `pageVar` is the current tab handle (`page` by default; `page2`, …
 *   after `newTab`). P0 output is byte-identical (default `page`).
 * - `upload` resolves the file path at run time from `VV_FILE_PATHS`
 *   (alias `FILE_PATHS`): JSON map fileId -> absolute path injected by the
 *   runner. Never inlines paths into code.
 * - `download` with `target`: `waitForEvent('download')` + click + `saveAs`
 *   (or `suggestedFilename()` when no hint). URL-only (no `target`):
 *   `page.evaluate(fetch)` so browser cookies/auth apply, then
 *   `node:fs/promises.writeFile` in Node. Decision documented in
 *   `compileTest` and mirrored by apps/runner.
 * - `newTab` needs `newPageVar` (deterministic `page2`, … allocated by
 *   `compileTest`); standalone calls without it fail explicitly.
 * - `closeTab` closes `pageVar`; the last-tab guard lives in `compileTest`.
 * - `handleDialog` registers a one-time `once('dialog')` handler for the
 *   NEXT dialog; it must precede the triggering step (no static next-step
 *   check — any step can trigger via JS).
 * - `apiRequest` uses the `request` fixture; `expectedStatus` throws
 *   explicitly on mismatch; `saveAs` stores `await resp.text()` into
 *   `process.env[saveAs]` for later `{{VAR}}` steps in the same process.
 */
export function compileStepBody(step: TestStep, pageVar = 'page', newPageVar?: string): string[] {
  // P2 plugin steps dispatch before the literal switch (prefix-matched).
  if (typeof step.type === 'string' && PLUGIN_TYPE_PATTERN.test(step.type)) {
    return compilePluginStepBody(step, pageVar);
  }
  switch (step.type) {
    case 'goto': {
      const url = requiredString(step, 'url');
      return [`await ${pageVar}.goto(${compileValueExpression(url)});`];
    }
    case 'reload':
      return [`await ${pageVar}.reload();`];
    case 'goBack':
      return [`await ${pageVar}.goBack();`];
    case 'goForward':
      return [`await ${pageVar}.goForward();`];
    case 'click':
      return [`await ${locatorToExpression(requiredTarget(step), pageVar)}.click();`];
    case 'doubleClick':
      return [`await ${locatorToExpression(requiredTarget(step), pageVar)}.dblclick();`];
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
        `await ${locatorToExpression(requiredTarget(step), pageVar)}.fill(${compileValueExpression(value)});`,
      ];
    }
    case 'clear':
      // `.clear()` is the canonical Playwright clear semantic; the single
      // spelling is shared with apps/runner compile.ts and web preview.
      return [`await ${locatorToExpression(requiredTarget(step), pageVar)}.clear();`];
    case 'press': {
      const key = requiredString(step, 'key');
      const target = asRecord(step)['target'] as LocatorSpec | undefined;
      if (target) {
        return [
          `await ${locatorToExpression(target, pageVar)}.press(${compileValueExpression(key)});`,
        ];
      }
      return [`await ${pageVar}.keyboard.press(${compileValueExpression(key)});`];
    }
    case 'check':
      return [`await ${locatorToExpression(requiredTarget(step), pageVar)}.check();`];
    case 'uncheck':
      return [`await ${locatorToExpression(requiredTarget(step), pageVar)}.uncheck();`];
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
      return [`await ${locatorToExpression(requiredTarget(step), pageVar)}.selectOption(${option});`];
    }
    case 'hover':
      return [`await ${locatorToExpression(requiredTarget(step), pageVar)}.hover();`];
    case 'waitForElement': {
      const state = asRecord(step)['state'];
      const allowed = ['visible', 'hidden', 'attached', 'detached'];
      if (state !== undefined && (typeof state !== 'string' || !allowed.includes(state))) {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (waitForElement): "state" must be one of ${allowed.join(', ')}`,
        );
      }
      const opts = typeof state === 'string' ? `{ state: ${stringLiteral(state)} }` : '';
      return [`await ${locatorToExpression(requiredTarget(step), pageVar)}.waitFor(${opts});`];
    }
    case 'waitForTimeout': {
      const ms = requiredNumber(step, 'milliseconds', 'ms');
      return [
        '// WARNING: fixed wait is discouraged; prefer waitForElement/waitForURL.',
        `await ${pageVar}.waitForTimeout(${Math.trunc(ms)});`,
      ];
    }
    case 'waitForURL': {
      const url = optionalString(step, 'url', 'pattern', 'expected');
      if (!url) {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (waitForURL): one of "url"/"pattern"/"expected" is required`,
        );
      }
      return [`await ${pageVar}.waitForURL(${compileUrlMatcher(url)});`];
    }
    case 'assertVisible': {
      const t = expectTimeout(step);
      return [`await expect(${locatorToExpression(requiredTarget(step), pageVar)}).toBeVisible(${t});`];
    }
    case 'assertHidden': {
      const t = expectTimeout(step);
      return [`await expect(${locatorToExpression(requiredTarget(step), pageVar)}).toBeHidden(${t});`];
    }
    case 'assertText': {
      const expected = optionalString(step, 'expected', 'value', 'text');
      if (expected === undefined) {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (assertText): field "expected" is required`,
        );
      }
      const t = expectTimeout(step);
      return [
        `await expect(${locatorToExpression(requiredTarget(step), pageVar)}).toHaveText(${compileValueExpression(expected)}${t ? `, ${t}` : ''});`,
      ];
    }
    case 'assertContainsText': {
      const expected = optionalString(step, 'expected', 'value', 'text');
      if (expected === undefined) {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (assertContainsText): field "expected" is required`,
        );
      }
      const t = expectTimeout(step);
      return [
        `await expect(${locatorToExpression(requiredTarget(step), pageVar)}).toContainText(${compileValueExpression(expected)}${t ? `, ${t}` : ''});`,
      ];
    }
    case 'assertValue': {
      const expected = optionalString(step, 'expected', 'value');
      if (expected === undefined) {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (assertValue): field "expected" is required`,
        );
      }
      const t = expectTimeout(step);
      return [
        `await expect(${locatorToExpression(requiredTarget(step), pageVar)}).toHaveValue(${compileValueExpression(expected)}${t ? `, ${t}` : ''});`,
      ];
    }
    case 'assertURL': {
      const expected = optionalString(step, 'expected', 'url', 'pattern');
      if (!expected) {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (assertURL): one of "expected"/"url"/"pattern" is required`,
        );
      }
      const t = expectTimeout(step);
      return [`await expect(${pageVar}).toHaveURL(${compileUrlMatcher(expected)}${t ? `, ${t}` : ''});`];
    }
    case 'assertTitle': {
      const expected = optionalString(step, 'expected', 'title');
      if (!expected) {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (assertTitle): one of "expected"/"title" is required`,
        );
      }
      const t = expectTimeout(step);
      return [`await expect(${pageVar}).toHaveTitle(${compileValueExpression(expected)}${t ? `, ${t}` : ''});`];
    }
    case 'assertEnabled': {
      const t = expectTimeout(step);
      return [`await expect(${locatorToExpression(requiredTarget(step), pageVar)}).toBeEnabled(${t});`];
    }
    case 'assertDisabled': {
      const t = expectTimeout(step);
      return [`await expect(${locatorToExpression(requiredTarget(step), pageVar)}).toBeDisabled(${t});`];
    }
    case 'assertChecked': {
      const t = expectTimeout(step);
      return [`await expect(${locatorToExpression(requiredTarget(step), pageVar)}).toBeChecked(${t});`];
    }
    case 'screenshot': {
      const r = asRecord(step);
      const name =
        typeof r['name'] === 'string' && r['name'] ? (r['name'] as string) : step.id;
      const opts: string[] = [`path: ${stringLiteral(`screenshots/${name}.png`)}`];
      if (r['fullPage'] === true) opts.push('fullPage: true');
      return [`await ${pageVar}.screenshot({ ${opts.join(', ')} });`];
    }
    case 'visualCheck': {
      return compileVisualCheckBody(step, pageVar);
    }
    case 'upload': {
      const fileId = requiredString(step, 'fileId');
      const loc = locatorToExpression(requiredTarget(step), pageVar);
      return [
        `const vvFile = (JSON.parse(process.env.${FILE_PATHS_ENV} ?? process.env.${FILE_PATHS_ENV_ALIAS} ?? '{}') as Record<string, string>)[${stringLiteral(fileId)}];`,
        `if (!vvFile) throw new Error(${stringLiteral(`upload "${step.id}": no file path for fileId "${fileId}" (runner injects ${FILE_PATHS_ENV} map)`)});`,
        `await ${loc}.setInputFiles(vvFile);`,
      ];
    }
    case 'download': {
      const r = asRecord(step);
      const target = r['target'] as LocatorSpec | undefined;
      const url = typeof r['url'] === 'string' && r['url'] ? (r['url'] as string) : undefined;
      const saveAs = typeof r['saveAs'] === 'string' && r['saveAs'] ? (r['saveAs'] as string) : undefined;
      if (!target && !url) {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (download): one of "target" or "url" is required`,
        );
      }
      if (target) {
        if (!target.primary) {
          throw new InvalidDefinitionError(
            `Step "${step.id}" (download): field "target.primary" is required`,
          );
        }
        const loc = locatorToExpression(target, pageVar);
        const saveExpr = saveAs ? stringLiteral(saveAs) : 'download.suggestedFilename()';
        return [
          `const downloadPromise = ${pageVar}.waitForEvent('download');`,
          `await ${loc}.click();`,
          `const download = await downloadPromise;`,
          `await download.saveAs(${saveExpr});`,
        ];
      }
      // URL-only: fetch inside the page so cookies/auth apply, then persist
      // from Node. `saveAs` defaults to a deterministic per-step filename.
      const outName = saveAs ?? `download-${step.id}`;
      return [
        `const vvBytes = await ${pageVar}.evaluate(async (vvUrl: string) => {`,
        `  const vvRes = await fetch(vvUrl);`,
        `  if (!vvRes.ok) throw new Error(\`download "${step.id}" failed with status \` + vvRes.status);`,
        `  return [...new Uint8Array(await vvRes.arrayBuffer())];`,
        `}, ${compileValueExpression(url!)});`,
        `await (await import('node:fs/promises')).writeFile(${stringLiteral(outName)}, Buffer.from(vvBytes));`,
      ];
    }
    case 'newTab': {
      if (!newPageVar) {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (newTab) requires a deterministic page name — compile via compileTest() so tabs are named page/page2/... explicitly`,
        );
      }
      const url = optionalString(step, 'url');
      const lines = [`const ${newPageVar} = await context.newPage();`];
      if (url) lines.push(`await ${newPageVar}.goto(${compileValueExpression(url)});`);
      return lines;
    }
    case 'closeTab':
      return [`await ${pageVar}.close();`];
    case 'handleDialog': {
      const r = asRecord(step);
      const action = r['action'];
      if (action !== 'accept' && action !== 'dismiss') {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (handleDialog): field "action" must be "accept" or "dismiss"`,
        );
      }
      const promptText = typeof r['promptText'] === 'string' && r['promptText'] ? (r['promptText'] as string) : undefined;
      if (action === 'accept') {
        return promptText
          ? [`${pageVar}.once('dialog', async (dialog) => { await dialog.accept(${compileValueExpression(promptText)}); });`]
          : [`${pageVar}.once('dialog', async (dialog) => { await dialog.accept(); });`];
      }
      return [`${pageVar}.once('dialog', async (dialog) => { await dialog.dismiss(); });`];
    }
    case 'apiRequest': {
      return compileApiRequestBody(step);
    }
    case 'mockRoute': {
      return compileMockRouteBody(step, pageVar);
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

/**
 * Deterministic artifact filename for a visual baseline name.
 * Mirror of `sanitizeVisualFileName` in apps/runner (keep the two in sync —
 * the runner's stub tests assert identical outputs for the same inputs).
 */
export function sanitizeVisualFileName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 120);
  return `visual-${safe.length > 0 ? safe : 'check'}.png`;
}

function requiredVisualName(step: TestStep): string {
  const r = asRecord(step);
  const name = r['name'];
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) {
    throw new InvalidDefinitionError(
      `Step "${step.id}" (visualCheck): field "name" must be a non-empty string (max 200 chars)`,
    );
  }
  return name;
}

function requiredVisualThreshold(step: TestStep): number {
  const r = asRecord(step);
  const threshold = r['threshold'];
  if (threshold === undefined) return VISUAL_DEFAULT_THRESHOLD;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new InvalidDefinitionError(
      `Step "${step.id}" (visualCheck): field "threshold" must be a number in [0, 1]`,
    );
  }
  return threshold;
}

/**
 * P2 visual regression: screenshot into the run artifact dir, then diff
 * against the server-injected baseline map (`VV_BASELINES`) via the
 * isolated-workdir helper. `VV_UPDATE_BASELINES=1` captures instead of
 * comparing (the server promotes the artifact to a baseline afterwards).
 */
function compileVisualCheckBody(step: TestStep, pageVar: string): string[] {
  const name = requiredVisualName(step);
  const threshold = requiredVisualThreshold(step);
  const fileName = sanitizeVisualFileName(name);
  const r = asRecord(step);
  const target = r['target'] as LocatorSpec | undefined;
  const shotTarget = target ? locatorToExpression(requiredTarget(step), pageVar) : pageVar;
  return [
    `const vvVisualPath = (await import('node:path')).join(process.env.RUN_ARTIFACT_DIR ?? '.', 'screenshots', ${stringLiteral(fileName)});`,
    `await ${shotTarget}.screenshot({ path: vvVisualPath });`,
    `await (await import('./vv-visual-compare.cjs')).compareVisualFromEnv({ name: ${stringLiteral(name)}, actualPath: vvVisualPath, threshold: ${JSON.stringify(threshold)} });`,
  ];
}

/**
 * P2 plugin step: call the registered helper with validated string params.
 * Param VALUES support the same `{{VARIABLE}}` / `{{row.*}}` interpolation
 * as every other step (compiled to `process.env.*` / `row[...]` lookups —
 * secrets are never inlined). Unknown plugin types fail here only when the
 * registry snapshot is passed via `CompileOptions.plugins`; otherwise the
 * workdir helper throws `PLUGIN_NOT_FOUND` at run time (never silent).
 */
function compilePluginStepBody(step: TestStep, pageVar: string): string[] {
  const r = asRecord(step);
  const rawParams = r['params'];
  let params: Record<string, string>;
  if (rawParams === undefined) {
    params = {};
  } else if (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)) {
    params = {};
    for (const [k, v] of Object.entries(rawParams as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (${step.type}): param "${k}" must be a string (use {{VARIABLE}} for secrets)`,
        );
      }
      params[k] = v;
    }
  } else {
    throw new InvalidDefinitionError(
      `Step "${step.id}" (${step.type}): field "params" must be a record of strings`,
    );
  }
  const entries = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const paramsExpr = `{ ${entries.map(([k, v]) => `${stringLiteral(k)}: ${compileValueExpression(v)}`).join(', ')} }`;
  return [
    `await (await import('./vv-plugins.cjs')).runPluginStep(${stringLiteral(step.type)}, ${paramsExpr}, ${pageVar}, { stepId: ${stringLiteral(step.id)} });`,
  ];
}

function compileApiRequestBody(step: TestStep): string[] {
  const r = asRecord(step);
  const methodRaw = r['method'];
  const allowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  if (typeof methodRaw !== 'string' || !allowedMethods.includes(methodRaw)) {
    throw new InvalidDefinitionError(
      `Step "${step.id}" (apiRequest): field "method" must be one of ${allowedMethods.join(', ')}`,
    );
  }
  const url = typeof r['url'] === 'string' && r['url'] ? (r['url'] as string) : undefined;
  if (!url) {
    throw new InvalidDefinitionError(
      `Step "${step.id}" (apiRequest): field "url" must be a non-empty string`,
    );
  }
  const method = (methodRaw as string).toLowerCase();
  const headersRaw = r['headers'];
  let headersExpr: string | undefined;
  if (headersRaw !== undefined) {
    if (!headersRaw || typeof headersRaw !== 'object' || Array.isArray(headersRaw)) {
      throw new InvalidDefinitionError(
        `Step "${step.id}" (apiRequest): field "headers" must be a record of strings`,
      );
    }
    const entries = Object.entries(headersRaw as Record<string, unknown>);
    for (const [k, v] of entries) {
      if (typeof v !== 'string') {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (apiRequest): header "${k}" must be a string (use {{VARIABLE}} for secrets)`,
        );
      }
    }
    const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    headersExpr = `{ ${sorted.map(([k, v]) => `${stringLiteral(k)}: ${compileValueExpression(v as string)}`).join(', ')} }`;
  }
  const bodyRaw = r['body'];
  let bodyExpr: string | undefined;
  if (bodyRaw !== undefined) {
    if (typeof bodyRaw !== 'string') {
      throw new InvalidDefinitionError(
        `Step "${step.id}" (apiRequest): field "body" must be a string (use {{VARIABLE}} for secrets)`,
      );
    }
    bodyExpr = compileValueExpression(bodyRaw);
  }
  const expectedRaw = r['expectedStatus'];
  if (expectedRaw !== undefined && !(typeof expectedRaw === 'number' && Number.isInteger(expectedRaw) && expectedRaw >= 100 && expectedRaw <= 599)) {
    throw new InvalidDefinitionError(
      `Step "${step.id}" (apiRequest): field "expectedStatus" must be an integer 100-599`,
    );
  }
  const saveAsRaw = r['saveAs'];
  if (saveAsRaw !== undefined && !(typeof saveAsRaw === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(saveAsRaw))) {
    throw new InvalidDefinitionError(
      `Step "${step.id}" (apiRequest): field "saveAs" must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
    );
  }
  const opts: string[] = [];
  if (headersExpr) opts.push(`headers: ${headersExpr}`);
  if (bodyExpr) opts.push(`data: ${bodyExpr}`);
  const urlExpr = compileValueExpression(url);
  const call = opts.length > 0 ? `await request.${method}(${urlExpr}, { ${opts.join(', ')} })` : `await request.${method}(${urlExpr})`;
  const lines = [`const vvResp = ${call};`];
  if (typeof expectedRaw === 'number') {
    lines.push(
      `if (vvResp.status() !== ${Math.trunc(expectedRaw)}) throw new Error(${stringLiteral(`apiRequest "${step.id}": expected status ${Math.trunc(expectedRaw)} but got `)} + vvResp.status());`,
    );
  }
  if (typeof saveAsRaw === 'string' && saveAsRaw) {
    lines.push(`process.env[${stringLiteral(saveAsRaw)}] = await vvResp.text();`);
  }
  return lines;
}

/**
 * mockRoute (Code-tab mirror of the runner compiler): register a
 * page.route() interception. Same validation, same emitted shape.
 */
function compileMockRouteBody(step: TestStep, pageVar: string): string[] {
  const r = asRecord(step);
  const allowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  const url = typeof r['url'] === 'string' && r['url'] ? (r['url'] as string) : undefined;
  if (!url) {
    throw new InvalidDefinitionError(
      `Step "${step.id}" (mockRoute): field "url" must be a non-empty string`,
    );
  }
  const methodRaw = r['method'];
  if (methodRaw !== undefined && (typeof methodRaw !== 'string' || !allowedMethods.includes(methodRaw))) {
    throw new InvalidDefinitionError(
      `Step "${step.id}" (mockRoute): field "method" must be one of ${allowedMethods.join(', ')}`,
    );
  }
  const statusRaw = r['status'];
  if (statusRaw !== undefined && !(typeof statusRaw === 'number' && Number.isInteger(statusRaw) && statusRaw >= 100 && statusRaw <= 599)) {
    throw new InvalidDefinitionError(
      `Step "${step.id}" (mockRoute): field "status" must be an integer 100-599`,
    );
  }
  const bodyRaw = r['body'];
  if (bodyRaw !== undefined && typeof bodyRaw !== 'string') {
    throw new InvalidDefinitionError(
      `Step "${step.id}" (mockRoute): field "body" must be a string (use {{VARIABLE}})`,
    );
  }
  const ctRaw = r['contentType'];
  if (ctRaw !== undefined && (typeof ctRaw !== 'string' || ctRaw.length === 0 || ctRaw.length > 200)) {
    throw new InvalidDefinitionError(
      `Step "${step.id}" (mockRoute): field "contentType" must be 1-200 chars`,
    );
  }
  const urlExpr = compileValueExpression(url);
  const fulfill: string[] = [`status: ${statusRaw !== undefined ? Math.trunc(statusRaw as number) : 200}`];
  if (typeof ctRaw === 'string') fulfill.push(`contentType: ${stringLiteral(ctRaw)}`);
  if (typeof bodyRaw === 'string') fulfill.push(`body: ${compileValueExpression(bodyRaw)}`);
  const handler =
    typeof methodRaw === 'string'
      ? `async (vvRoute) => { if (vvRoute.request().method() !== ${stringLiteral(methodRaw)}) return vvRoute.fallback(); await vvRoute.fulfill({ ${fulfill.join(', ')} }); }`
      : `async (vvRoute) => { await vvRoute.fulfill({ ${fulfill.join(', ')} }); }`;
  return [`await ${pageVar}.route(${urlExpr}, ${handler});`];
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
  /**
   * P2 plugin registry snapshot (step type -> compile info). When provided,
   * a `plugin:*` step whose type is absent fails compilation here with
   * `PLUGIN_NOT_FOUND`; when omitted, the check moves to run time (the
   * workdir helper throws the same explicit error — never silently skipped).
   */
  plugins?: Record<string, PluginCompileInfo>;
}

/**
 * Minimal per-type compile info for a registered plugin step (structural
 * mirror of the SDK `PluginStepSchema` — kept local so this package has no
 * runtime dependency on `@playwright-studio/action-sdk`).
 */
export interface PluginCompileInfo {
  schema?: {
    required?: string[];
    properties?: Record<string, { type: string; maxLength?: number; default?: string; secret?: boolean }>;
  };
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
 *
 * P1 wave-2: body steps compile against the caller's current `pageVar`
 * (multi-tab state never crosses the action boundary — `newTab`/`closeTab`
 * inside an action body fail explicitly).
 */
function emitCallActionBlock(
  caller: TestStep,
  action: ReusableAction,
  baseIndent: string,
  dataset: boolean,
  pageVar = 'page',
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
    if (bodyStep.type === 'newTab' || bodyStep.type === 'closeTab') {
      throw new UnsupportedStepError(
        caller.id,
        'callAction',
        `Step "${caller.id}" (callAction) cannot inline action "${action.name}" (${action.id}): body step "${bodyStep.id}" (${bodyStep.type}) manages tabs — multi-tab state never crosses the action boundary`,
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
        compileStepBody(interpolated, pageVar),
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

/**
 * Fail fast for plugin steps when the registry snapshot is available:
 * unknown type -> PLUGIN_NOT_FOUND; missing required param / plaintext
 * secret literal -> InvalidDefinitionError (a secret literal would otherwise
 * be inlined into generated code). Without the snapshot these checks move to
 * the run-time workdir helper (same explicit errors, never silent).
 */
function assertPluginStep(step: TestStep, plugins?: Record<string, PluginCompileInfo>): void {
  if (!plugins) return;
  const info = Object.prototype.hasOwnProperty.call(plugins, step.type) ? plugins[step.type] : undefined;
  if (!info) {
    throw new UnsupportedStepError(
      step.id,
      step.type,
      `PLUGIN_NOT_FOUND: step "${step.id}" references unregistered plugin step "${step.type}" — install the plugin (PLUGINS_DIR) and enable it (ALLOW_PLUGINS=1, Developer/Admin review)`,
    );
  }
  const schema = info.schema;
  if (!schema) return;
  const raw = asRecord(step)['params'];
  const params = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  for (const req of schema.required ?? []) {
    if (typeof params[req] !== 'string') {
      throw new InvalidDefinitionError(
        `Step "${step.id}" (${step.type}): missing required param "${req}"`,
      );
    }
  }
  for (const [k, decl] of Object.entries(schema.properties ?? {})) {
    const v = params[k];
    if (typeof v === 'string' && decl.secret === true && !hasVariable(v)) {
      throw new InvalidDefinitionError(
        `Step "${step.id}" (${step.type}): secret param "${k}" must be a {{VARIABLE}} reference so the secret is resolved at run time, never inlined`,
      );
    }
  }
}

export function compileTest(def: TestDefinition, opts?: CompileOptions): string {
  validateDefinition(def);
  const dataset = resolveDataset(def, opts?.datasetId);
  if (!dataset) assertNoRowReferences(def, opts?.actions);

  // P1 wave-2 fixtures: `context` only when a `newTab` step exists,
  // `request` only when an `apiRequest` step exists (including inside an
  // inlined action body). P0 definitions keep `async ({ page })` exactly.
  const needsContext = def.steps.some(
    (s) => s.enabled !== false && s.type === 'newTab',
  );
  const needsRequest = def.steps.some((s) => {
    if (s.enabled === false) return false;
    if (s.type === 'apiRequest') return true;
    if (s.type === 'callAction') {
      const actionId = asRecord(s)['actionId'];
      const action = typeof actionId === 'string' ? lookupAction(opts?.actions, actionId) : undefined;
      return !!action?.steps.some((b) => b.enabled !== false && b.type === 'apiRequest');
    }
    return false;
  });
  const fixtures = ['page', ...(needsContext ? ['context'] : []), ...(needsRequest ? ['request'] : [])].join(', ');

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
  out.push(`test(${stringLiteral(def.name)}, async ({ ${fixtures} }) => {`);

  // Extra indentation level inside the dataset loop (0 for P0 output).
  const pad = dataset ? '  ' : '';
  if (dataset) {
    out.push(`  // Data-driven: dataset ${stringLiteral(dataset.name)} (${dataset.id}) — rows come from VV_DATASET_ROWS.`);
    out.push(`  // ${DATASET_SECRET_NOTE}`);
    out.push(`  const VV_ROWS: Array<Record<string, string>> = JSON.parse(process.env.VV_DATASET_ROWS ?? '[]');`);
    out.push(`  for (let _vvIteration = 0; _vvIteration < (VV_ROWS.length ? VV_ROWS.length : 1); _vvIteration++) {`);
    out.push(`    const row: Record<string, string> = VV_ROWS[_vvIteration] ?? {};`);
  }

  // P1 wave-2 tab tracking: deterministic stack, `page` first, then
  // `page2`, `page3`, … Disabled steps emit a comment and never touch the
  // stack (they do not execute). `closeTab` on the last tab fails
  // explicitly — closing it would leave the test with no page.
  const pageStack: string[] = ['page'];
  let pageCounter = 1;

  def.steps.forEach((step, index) => {
    if (index > 0) out.push('');
    if (step.enabled === false) {
      out.push(`${pad}  // skipped disabled step ${step.id} (${step.type})`);
      return;
    }
    const currentPage = pageStack[pageStack.length - 1];
    if (step.type === 'newTab') {
      pageCounter += 1;
      const newPageVar = pageCounter === 2 ? 'page2' : `page${pageCounter}`;
      out.push(
        ...emitTestStepBlock(
          step,
          stepTitleExpr(step, step.name ?? defaultStepName(step), dataset !== undefined),
          compileStepBody(step, currentPage, newPageVar),
          `${pad}  `,
        ),
      );
      pageStack.push(newPageVar);
      return;
    }
    if (step.type === 'closeTab') {
      if (pageStack.length <= 1) {
        throw new InvalidDefinitionError(
          `Step "${step.id}" (closeTab): cannot close the last remaining tab — at least one page must stay open`,
        );
      }
      out.push(
        ...emitTestStepBlock(
          step,
          stepTitleExpr(step, step.name ?? defaultStepName(step), dataset !== undefined),
          compileStepBody(step, currentPage),
          `${pad}  `,
        ),
      );
      pageStack.pop();
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
      out.push(...emitCallActionBlock(step, action, `${pad}  `, dataset !== undefined, currentPage));
      return;
    }
    if (typeof step.type === 'string' && PLUGIN_TYPE_PATTERN.test(step.type)) {
      assertPluginStep(step, opts?.plugins);
    }
    out.push(
      ...emitTestStepBlock(
        step,
        stepTitleExpr(step, step.name ?? defaultStepName(step), dataset !== undefined),
        compileStepBody(step, currentPage),
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
 *
 * P1 wave-2 adds `body`/`headers` (apiRequest) and `promptText`
 * (handleDialog); `url` already covers goto/newTab/download/apiRequest.
 * P2 adds `params` (plugin steps — record of strings).
 */
const INTERPOLATED_FIELDS = ['url', 'value', 'key', 'expected', 'pattern', 'body', 'headers', 'promptText', 'params'] as const;

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
 * Inlined action bodies are scanned as well (apiRequest body/headers and
 * any value field may carry row refs).
 */
function assertNoRowReferences(def: TestDefinition, actions?: ActionsContext): void {
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
      const actionId = asRecord(step)['actionId'];
      const action = typeof actionId === 'string' ? lookupAction(actions, actionId) : undefined;
      if (action) {
        for (const bodyStep of action.steps) {
          if (bodyStep.enabled === false) continue;
          const interpolated = interpolateActionStep(bodyStep, {});
          hits.push(...collectInterpolatedStrings(interpolated));
          if (hits.length > 0) break;
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
