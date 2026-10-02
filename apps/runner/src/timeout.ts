/**
 * Timeout inheritance: Project default -> Test override -> Step override.
 * The resolved per-step map is exposed in result.json so the UI can show
 * exactly which level each timeout came from (runner-spec.md).
 */

import type { TestDefinition, TestStep } from './types.js';

export const DEFAULT_TEST_TIMEOUT_MS = 60_000;
export const DEFAULT_STEP_TIMEOUT_MS = 30_000;

export type TimeoutSource = 'step' | 'test' | 'project' | 'default';

export interface ResolvedStepTimeout {
  stepId: string;
  timeoutMs: number;
  source: TimeoutSource;
}

function pick(value: number | undefined, source: TimeoutSource): { timeoutMs: number; source: TimeoutSource } | null {
  if (value !== undefined && Number.isFinite(value) && value > 0) return { timeoutMs: value, source };
  return null;
}

/** Effective timeout for a single step. */
export function resolveStepTimeout(
  step: Pick<TestStep, 'timeoutMs'>,
  test: Pick<TestDefinition, 'timeoutMs'>,
  projectDefaultTimeoutMs?: number,
): ResolvedStepTimeout {
  return {
    stepId: (step as { id?: string }).id ?? '',
    ...(pick(step.timeoutMs, 'step') ??
      pick(test.timeoutMs, 'test') ??
      pick(projectDefaultTimeoutMs, 'project') ?? { timeoutMs: DEFAULT_STEP_TIMEOUT_MS, source: 'default' as const }),
  };
}

/** Effective timeouts for every step in the definition (deterministic order). */
export function resolveTimeouts(
  test: TestDefinition,
  projectDefaultTimeoutMs?: number,
): ResolvedStepTimeout[] {
  return test.steps.map((step) => resolveStepTimeout(step, test, projectDefaultTimeoutMs));
}

/** Effective whole-test timeout (Playwright test.setTimeout equivalent). */
export function resolveTestTimeout(test: TestDefinition, projectDefaultTimeoutMs?: number): number {
  return (
    pick(test.timeoutMs, 'test') ?? pick(projectDefaultTimeoutMs, 'project') ?? { timeoutMs: DEFAULT_TEST_TIMEOUT_MS, source: 'default' as const }
  ).timeoutMs;
}
