/**
 * Shared runner types.
 * Mirrors 03-test-model/test-definition.md, 07-runner/runner-spec.md,
 * 08-api/websocket-events.md and 09-database/schema.md.
 */

// ---- Status enums (runner-spec.md) ----
export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export const RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'running',
  'passed',
  'failed',
  'cancelled',
];

export const STEP_STATUSES: readonly StepStatus[] = [
  'pending',
  'running',
  'passed',
  'failed',
  'skipped',
];

// ---- Test model (03-test-model/test-definition.md) ----
export type BrowserName = 'chromium' | 'firefox' | 'webkit';

export type LocatorCandidate =
  | { strategy: 'role'; role: string; name?: string; exact?: boolean }
  | { strategy: 'label'; value: string; exact?: boolean }
  | { strategy: 'placeholder'; value: string; exact?: boolean }
  | { strategy: 'testId'; value: string }
  | { strategy: 'text'; value: string; exact?: boolean }
  | { strategy: 'css'; value: string }
  | { strategy: 'xpath'; value: string };

export interface LocatorSpec {
  primary: LocatorCandidate;
  alternatives?: LocatorCandidate[];
}

export interface BaseStep {
  id: string;
  type: string;
  name?: string;
  enabled: boolean;
  timeoutMs?: number;
  continueOnFailure?: boolean;
  // P0 step payloads (see step-catalog.md)
  url?: string;
  target?: LocatorSpec;
  value?: string;
  sensitive?: boolean;
  key?: string;
  state?: string;
  milliseconds?: number;
  expected?: string;
  pattern?: string;
  fullPage?: boolean;
  // P1 reusable-action invocation (see ReusableAction below)
  actionId?: string;
  arguments?: Record<string, string>;
  // P1 wave-2 (shapes mirror packages/test-model/src/types.ts)
  fileId?: string;
  saveAs?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  expectedStatus?: number;
  action?: string;
  promptText?: string;
}

export type TestStep = BaseStep;

/** P1 — a named parameter of a reusable action. */
export interface ActionParameter {
  name: string;
  description?: string;
  /** Used when the caller omits the argument. */
  default?: string;
  /** Secret params must be passed as {{VARIABLE}} refs — never literals. */
  secret?: boolean;
}

/**
 * P1 — reusable business action (project-scoped). Body steps are P0 steps
 * only: nested `callAction` is rejected at compile time with an explicit
 * error (keeps inlining total and readable).
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

export interface TestDefinition {
  schemaVersion: '1.0';
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
  /** P1 — embedded data tables; a run selects one via RunRequest.datasetId. */
  datasets?: DataSet[];
  steps: TestStep[];
}

/** P1 — one named table of plaintext rows for data-driven runs. */
export interface DataSet {
  id: string;
  name: string;
  rows: Record<string, string>[];
}

// ---- Run request / records (08-api/api-spec.md + 09-database/schema.md) ----
export interface VariableDef {
  key: string;
  value: string;
  isSecret: boolean;
}

export interface RunArtifactsOptions {
  trace?: 'on' | 'off' | 'retain-on-failure';
  screenshot?: 'on' | 'off' | 'only-on-failure';
  video?: 'on' | 'off' | 'retain-on-failure';
  retentionDays?: number;
}

export interface RunRequest {
  /** unique run id (server-generated, e.g. nanoid/uuid) */
  runId: string;
  test: TestDefinition;
  projectId: string;
  environmentId?: string;
  browser?: BrowserName;
  headed?: boolean;
  /** P1 data-driven: dataset id selected at trigger time (must exist in test.datasets). */
  datasetId?: string;
  /** P1 data-driven: run a single row only (0-based index into the dataset). */
  rowIndex?: number;
  /**
   * P1 reusable actions: resolved callee bodies for `callAction` steps.
   * Optional (existing callers keep working); when a definition contains
   * `callAction` but the action is absent here, compilation fails
   * explicitly — never silently skipped.
   */
  actions?: ReusableAction[];
  /**
   * P1 wave-2 files: fileId -> absolute path map for `upload` steps.
   * The runner injects it as `VV_FILE_PATHS` (alias `FILE_PATHS`) JSON;
   * the spec resolves paths at run time (never inlined into code).
   */
  filePaths?: Record<string, string>;
  /**
   * P1 auth context: decrypted storageState JSON content. The runner
   * materializes it as `storageState.json` in the isolated workDir and
   * points the Playwright config at it; the file is removed with the
   * workDir in step 8. Undefined (default) keeps a fresh context.
   * How the server resolves/decrypts this value is agent B's scope —
   * the runner only receives and materializes it.
   */
  storageStateJson?: string;
  /** project-level default timeout (ms) */
  projectDefaultTimeoutMs?: number;
  /** project-level non-secret variables */
  projectVariables?: VariableDef[];
  /** environment-level variables (override project) */
  environmentVariables?: VariableDef[];
  trigger?: string;
  triggeredBy?: string;
  artifacts?: RunArtifactsOptions;
}

export interface StepRecord {
  id: string;
  runId: string;
  stepId: string;
  sortOrder: number;
  status: StepStatus;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  errorMessage?: string;
  screenshotPath?: string;
  /** effective timeout after Project -> Test -> Step inheritance */
  timeoutMs: number;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  type: 'result' | 'trace' | 'video' | 'screenshot' | 'report';
  /** path relative to storage root, e.g. runs/<run-id>/trace.zip */
  path: string;
  mimeType: string;
  sizeBytes?: number;
}

export interface RunRecord {
  id: string;
  projectId: string;
  testId: string;
  environmentId?: string;
  browser: BrowserName;
  status: RunStatus;
  trigger?: string;
  /** P1 data-driven selection (persisted; Prisma Run has matching columns). */
  datasetId?: string;
  rowIndex?: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  errorSummary?: string;
}

export interface RunSummary {
  run: RunRecord;
  steps: StepRecord[];
  artifacts: ArtifactRecord[];
}
