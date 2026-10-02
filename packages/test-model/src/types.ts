/**
 * Canonical P0 test-model types.
 * Sources: 03-test-model/test-definition.md, 03-test-model/step-catalog.md.
 *
 * JSON definition is canonical (ADR-002). Generated Playwright code is output only.
 * Stored definitions must never be silently mutated; migrations are explicit
 * (see migrations.ts) and validated by schemas.ts.
 */

export const CURRENT_SCHEMA_VERSION = "1.0" as const;
export type SchemaVersion = typeof CURRENT_SCHEMA_VERSION;

export type BrowserName = "chromium" | "firefox" | "webkit";

export interface TestDefinition {
  schemaVersion: "1.0";
  id: string;
  projectId: string;
  name: string;
  description?: string;
  browser: BrowserName;
  baseUrl?: string;
  viewport?: { width: number; height: number };
  timeoutMs?: number;
  tags?: string[];
  variables?: Record<string, string>;
  /** P1 — embedded data tables; selected per run via `datasetId`. */
  datasets?: DataSet[];
  steps: TestStep[];
}

export interface BaseStep {
  id: string;
  type: string;
  name?: string;
  enabled: boolean;
  timeoutMs?: number;
  continueOnFailure?: boolean;
}

// ---------------------------------------------------------------- Locator ---

export interface LocatorSpec {
  primary: LocatorCandidate;
  alternatives?: LocatorCandidate[];
}

export type LocatorCandidate =
  | { strategy: "role"; role: string; name?: string; exact?: boolean }
  | { strategy: "label"; value: string; exact?: boolean }
  | { strategy: "placeholder"; value: string; exact?: boolean }
  | { strategy: "testId"; value: string }
  | { strategy: "text"; value: string; exact?: boolean }
  | { strategy: "css"; value: string }
  | { strategy: "xpath"; value: string };

// ------------------------------------------------------------------ Steps ---

/** Navigation */
export interface GotoStep extends BaseStep {
  type: "goto";
  url: string;
}
export interface ReloadStep extends BaseStep {
  type: "reload";
}
export interface GoBackStep extends BaseStep {
  type: "goBack";
}
export interface GoForwardStep extends BaseStep {
  type: "goForward";
}

/** Interaction */
export interface ClickStep extends BaseStep {
  type: "click";
  target: LocatorSpec;
}
export interface DoubleClickStep extends BaseStep {
  type: "doubleClick";
  target: LocatorSpec;
}
export interface FillStep extends BaseStep {
  type: "fill";
  target: LocatorSpec;
  value: string;
  sensitive?: boolean;
}
export interface ClearStep extends BaseStep {
  type: "clear";
  target: LocatorSpec;
}
export interface PressStep extends BaseStep {
  type: "press";
  target?: LocatorSpec;
  key: string;
}
export interface CheckStep extends BaseStep {
  type: "check";
  target: LocatorSpec;
}
export interface UncheckStep extends BaseStep {
  type: "uncheck";
  target: LocatorSpec;
}
export interface SelectStep extends BaseStep {
  type: "select";
  target: LocatorSpec;
  value: string;
}
export interface HoverStep extends BaseStep {
  type: "hover";
  target: LocatorSpec;
}

/** Wait */
export type WaitForElementState = "attached" | "detached" | "visible" | "hidden";
export interface WaitForElementStep extends BaseStep {
  type: "waitForElement";
  target: LocatorSpec;
  state: WaitForElementState;
}
export interface WaitForTimeoutStep extends BaseStep {
  type: "waitForTimeout";
  /** Fixed wait in ms. Discouraged — UI must show a visible warning. */
  milliseconds: number;
}
export interface WaitForURLStep extends BaseStep {
  type: "waitForURL";
  url?: string;
  pattern?: string;
}

/** Assertions */
export interface AssertVisibleStep extends BaseStep {
  type: "assertVisible";
  target: LocatorSpec;
}
export interface AssertHiddenStep extends BaseStep {
  type: "assertHidden";
  target: LocatorSpec;
}
export interface AssertTextStep extends BaseStep {
  type: "assertText";
  target: LocatorSpec;
  expected: string;
}
export interface AssertContainsTextStep extends BaseStep {
  type: "assertContainsText";
  target: LocatorSpec;
  expected: string;
}
export interface AssertValueStep extends BaseStep {
  type: "assertValue";
  target: LocatorSpec;
  expected: string;
}
export interface AssertURLStep extends BaseStep {
  type: "assertURL";
  expected?: string;
  pattern?: string;
}
export interface AssertTitleStep extends BaseStep {
  type: "assertTitle";
  expected: string;
}
export interface AssertEnabledStep extends BaseStep {
  type: "assertEnabled";
  target: LocatorSpec;
}
export interface AssertDisabledStep extends BaseStep {
  type: "assertDisabled";
  target: LocatorSpec;
}
export interface AssertCheckedStep extends BaseStep {
  type: "assertChecked";
  target: LocatorSpec;
}

/** Utility */
export interface ScreenshotStep extends BaseStep {
  type: "screenshot";
  name?: string;
  fullPage?: boolean;
}

// --------------------------------------------------------------- P1 ---
// P1 additions are strictly additive: P0 parsers/compilers that do not know
// these shapes must reject them explicitly (never silently skip).

/** P1 — a named parameter of a reusable action. */
export interface ActionParameter {
  name: string;
  description?: string;
  /** Used when the caller omits the argument. */
  default?: string;
  /** Secret params resolve at run time and are redacted like variables. */
  secret?: boolean;
}

/**
 * P1 — reusable business action (project-scoped, stored in `actions` table).
 * Body steps are P0 steps only: nested `callAction` is rejected at compile
 * time with an explicit error (keeps inlining total and readable).
 */
export interface ReusableAction {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  parameters: ActionParameter[];
  steps: TestStep[];
}

/** P1 — invoke a reusable action with argument values. */
export interface CallActionStep extends BaseStep {
  type: "callAction";
  actionId: string;
  arguments?: Record<string, string>;
}

/** P1 — one named table of rows for data-driven runs (embedded, capped). */
export interface DataSet {
  id: string;
  name: string;
  rows: Record<string, string>[];
}

/** Maximum embedded dataset rows per definition (artifact/size discipline). */
export const MAX_DATASET_ROWS = 500;

export type TestStep =
  | GotoStep
  | ReloadStep
  | GoBackStep
  | GoForwardStep
  | ClickStep
  | DoubleClickStep
  | FillStep
  | ClearStep
  | PressStep
  | CheckStep
  | UncheckStep
  | SelectStep
  | HoverStep
  | WaitForElementStep
  | WaitForTimeoutStep
  | WaitForURLStep
  | AssertVisibleStep
  | AssertHiddenStep
  | AssertTextStep
  | AssertContainsTextStep
  | AssertValueStep
  | AssertURLStep
  | AssertTitleStep
  | AssertEnabledStep
  | AssertDisabledStep
  | AssertCheckedStep
  | ScreenshotStep
  | CallActionStep;

export type StepType = TestStep["type"];

/** Full P0 step-type list (27 types). */
export const P0_STEP_TYPES: readonly StepType[] = [
  "goto",
  "reload",
  "goBack",
  "goForward",
  "click",
  "doubleClick",
  "fill",
  "clear",
  "press",
  "check",
  "uncheck",
  "select",
  "hover",
  "waitForElement",
  "waitForTimeout",
  "waitForURL",
  "assertVisible",
  "assertHidden",
  "assertText",
  "assertContainsText",
  "assertValue",
  "assertURL",
  "assertTitle",
  "assertEnabled",
  "assertDisabled",
  "assertChecked",
  "screenshot",
] as const;

/** P1 step types (require P1-aware compiler/runner; P0 tooling rejects them). */
export const P1_STEP_TYPES: readonly string[] = ["callAction"] as const;
