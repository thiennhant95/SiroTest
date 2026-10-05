import type { RunDetail } from "../types";

/**
 * Sample run for local verify without backend.
 * Mirrors storage/runs/<run-id>/result.json shape.
 */
export const SAMPLE_RUN_ID = "run_demo_login_fail";

export const sampleRun: RunDetail = {
  id: SAMPLE_RUN_ID,
  testId: "test_demo_login",
  testName: "Staging login",
  status: "failed",
  environment: "Staging",
  environmentId: "env_staging",
  browser: "chromium",
  startedAt: new Date(Date.now() - 42_000).toISOString(),
  finishedAt: new Date().toISOString(),
  durationMs: 18_400,
  errorSummary: "Step 4 “Click Login” couldn't find the button after 5s",
  steps: [
    {
      id: "r1",
      stepId: "s1",
      name: "1. Open /login page",
      status: "passed",
      durationMs: 2100,
    },
    {
      id: "r2",
      stepId: "s2",
      name: "2. Enter email",
      status: "passed",
      durationMs: 1300,
    },
    {
      id: "r3",
      stepId: "s3",
      name: "3. Enter password",
      status: "passed",
      durationMs: 1100,
    },
    {
      id: "r4",
      stepId: "s4",
      name: "4. Click Login",
      status: "failed",
      durationMs: 5200,
      locatorExpression: "page.getByRole('button', { name: 'Login' })",
      timeoutMs: 5000,
      timeoutSource: "step",
      error:
        "Couldn't find the “Login” button after 5s. It may have been renamed or not yet visible — check the locator.",
      rawError: `TimeoutError: locator.click: Target closed
  at step s4 (click) — page.getByRole('button', { name: 'Login' }).click()
  Call log:
    - waiting for getByRole('button', { name: 'Login' })
    - attempt 12/50 … not found
  [REDACTED: secret values never appear here]`,
      screenshotUrl:
        "data:image/svg+xml," +
        encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#f1f5f9"/><rect x="200" y="90" width="240" height="180" rx="8" fill="#fff" stroke="#cbd5e1"/><text x="320" y="170" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#334155">Failure screenshot (demo)</text><text x="320" y="195" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#64748b">Login button not visible</text></svg>`,
        ),
    },
    {
      id: "r5",
      stepId: "s5",
      name: "5. Verify Dashboard loaded",
      status: "skipped",
      durationMs: 0,
    },
  ],
  artifacts: {
    traceUrl: "https://example.com/storage/runs/run_demo/trace.zip",
    videoUrl: undefined,
    screenshots: [],
    reportUrl: undefined,
  },
};

export const sampleRunningRun: RunDetail = {
  ...sampleRun,
  id: "run_demo_running",
  status: "running",
  errorSummary: undefined,
  finishedAt: null,
  steps: sampleRun.steps.slice(0, 3),
};
