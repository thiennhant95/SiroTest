/** Day 7 shared types — mirrors 08-api/api-spec.md + 07-runner/artifacts-reporting.md */

export type RunStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "cancelled";

export interface StepResult {
  id: string;
  /** step id inside TestDefinition (for "Edit failing locator" deep-link). */
  stepId?: string;
  name: string;
  status: RunStatus | "skipped";
  durationMs: number;
  error?: string;
  /** raw stack — only shown to Developer role, redacted server-side. */
  rawError?: string;
  screenshotUrl?: string;
}

export interface RunDetail {
  id: string;
  testId: string;
  testName: string;
  status: RunStatus;
  environment: string;
  environmentId?: string;
  browser: string;
  startedAt: string;
  finishedAt?: string | null;
  durationMs: number;
  steps: StepResult[];
  /** failing terse message for header */
  errorSummary?: string;
  artifacts: {
    traceUrl?: string;
    videoUrl?: string;
    screenshots: string[];
    reportUrl?: string;
  };
}

export interface TestVersion {
  id: string;
  testId: string;
  versionNumber: number;
  createdBy: string;
  changeMessage?: string | null;
  createdAt: string;
  /** definition snapshot (only loaded for preview) */
  definitionJson?: unknown;
}

export type UserRole = "tester" | "developer";

export interface TestDefinitionStep {
  id: string;
  type: string;
  name?: string;
  [k: string]: unknown;
}
