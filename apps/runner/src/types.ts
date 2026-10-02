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
}

export type TestStep = BaseStep;

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
  steps: TestStep[];
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
