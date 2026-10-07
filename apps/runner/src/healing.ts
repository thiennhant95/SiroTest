/**
 * P2 — explicit, reviewable locator healing (ADR-003, ADR-005, 05-locator).
 *
 * NEVER auto-applies. This module only *proposes*: given a failed
 * locator-bearing step plus its stored `alternatives`, it walks the
 * alternatives in stored order and reports which one (if any) matches
 * uniquely. The failing step keeps status `failed` (a broken primary is a
 * fact), the proposal is emitted as a `step.healed` WS event and returned in
 * the run result so the SERVER can persist a `HealingProposal` row
 * (status `pending`). A human approves/rejects via the healing API — the
 * definition is rewritten only on explicit approval, which demotes the old
 * primary to the head of `alternatives` and mints a new test version.
 *
 * "Re-run the step with the healed locator" happens on the NEXT run after
 * approval — never silently inside the failed run (that would be silent
 * self-healing, forbidden in P0 and unauditable in P2).
 *
 * P0 behavior is unchanged: healing runs only when
 * `RunRequest.healWithAlternatives === true` (default false).
 *
 * NOTE: the candidate preview formatter below intentionally duplicates the
 * minimal logic of `packages/locator-engine/src/toExpression.ts` instead of
 * importing it — `@playwright-studio/runner` has no dependency on the
 * locator engine (see apps/runner/package.json) and this file must stay
 * dependency-free and unit-testable without a browser.
 */

import type { LocatorCandidate, TestStep } from './types.js';

/** WS event name for a healing proposal discovered post-failure. */
/* eslint-disable @typescript-eslint/naming-convention -- event contract */
export const STEP_HEALED_EVENT = 'step.healed' as const;
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Probe headroom (ms) reserved when healing probes are compiled in. The
 * primary action is capped by `actionTimeout` at the plain timeout while the
 * test/step timeout is extended by this budget, so read-only alternative
 * counts still run after a primary failure instead of dying with the test.
 */
export const HEALING_PROBE_BUDGET_MS = 15_000;

/**
 * Live match counter for one alternative candidate.
 * In production (no live page handle in the runner host — the browser lives
 * inside the Playwright child) this is injected by the caller when a probe
 * page is available; tests inject a stub. Returning `undefined` means
 * "unknown" (unverified), never 0.
 */
export type HealProbe = (candidate: LocatorCandidate) => number | undefined;

/** Ordered evidence attached to a `step.healed` event + run result. */
export interface HealEvidence {
  /** Human-readable previews of every alternative tried, in stored order. */
  tried: string[];
  /** Winning alternative (unique match). Absent when nothing matched uniquely. */
  succeededWith?: LocatorCandidate;
  /** Match count of the winner (always 1 when `verified` is true). */
  matchCount?: number;
  /** Readable preview of the winner, e.g. `testId="login-btn"`. */
  preview?: string;
  /** True only when a live probe confirmed a unique match. */
  verified: boolean;
  /** Wall-clock ms spent walking the alternatives. */
  durationMs: number;
  /** Machine-readable failure class, e.g. `locator-timeout`. */
  reason: string;
}

/** One step-level healing outcome (step itself stays `failed`). */
export interface HealAttempt {
  stepId: string;
  fromLocator: LocatorCandidate;
  evidence: HealEvidence;
}

/**
 * Step types that carry a `target: LocatorSpec` (03-test-model/step-catalog.md
 * + validate.ts STEPS_REQUIRING_TARGET, minus `press` whose target is
 * optional and minus P1 wave-2 extras the healer does not reason about).
 */
export const LOCATOR_BEARING_STEP_TYPES: ReadonlySet<string> = new Set([
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

export function isLocatorBearingStep(step: Pick<TestStep, 'type'>): boolean {
  return LOCATOR_BEARING_STEP_TYPES.has(step.type);
}

/**
 * Assertion-failure markers (Playwright `expect`) — these must NEVER be
 * treated as locator failures, even though assertion timeouts also contain
 * the word "Timeout ... exceeded". Checked FIRST.
 */
const ASSERTION_MARKERS: RegExp[] = [
  /expect\s*\(/i,
  /assertionerror/i,
  /\bexpected\b.*\breceived\b/is,
  /expected:/i,
  /received:/i,
  /toBeVisible|toBeHidden|toHaveText|toContainText|toHaveValue|toHaveURL|toHaveTitle|toBeChecked|toBeEnabled|toBeDisabled/i,
];

/** Locator-failure markers (Playwright actionability / waiting errors). */
const LOCATOR_MARKERS: RegExp[] = [
  /waiting for (selector|locator|getby)/i,
  /timeout .* exceeded/i,
  /strict mode violation/i,
  /locator .* resolved to 0/i,
  /element is not (visible|stable|enabled)/i,
  /element .* not found/i,
  /no element found for/i,
];

/**
 * True only for genuine locator failures (actionability timeouts,
 * waiting-for-selector, strict-mode violations). Assertion failures and any
 * other error class return false — healing must not fire on them.
 *
 * Exception: an `expect()` error whose call log proves the locator resolved
 * to NOTHING (`element(s) not found`, `resolved to 0`) IS a locator failure:
 * the element is gone, not the expectation wrong. This is the common
 * "assertVisible fails because the element vanished" case — without it,
 * healing would never fire for assertion steps, which compile to
 * `expect(locator).toBeVisible()` etc.
 */
const NOT_FOUND_MARKERS: RegExp[] = [
  /locator .* resolved to 0/i,
  /element\(s\) not found/i,
  /no element found for/i,
];

export function isLocatorFailure(errorMessage: string): boolean {
  if (!errorMessage) return false;
  if (NOT_FOUND_MARKERS.some((re) => re.test(errorMessage))) return true;
  if (ASSERTION_MARKERS.some((re) => re.test(errorMessage))) return false;
  return LOCATOR_MARKERS.some((re) => re.test(errorMessage));
}

/** Short human-readable summary, e.g. `role=button name="Login"`. */
export function previewHealingCandidate(candidate: LocatorCandidate): string {
  switch (candidate.strategy) {
    case 'role':
      return candidate.name ? `role=${candidate.role} name="${candidate.name}"` : `role=${candidate.role}`;
    case 'label':
      return `label="${candidate.value}"`;
    case 'placeholder':
      return `placeholder="${candidate.value}"`;
    case 'testId':
      return `testId="${candidate.value}"`;
    case 'text':
      return `text="${candidate.value}"`;
    case 'css':
      return `css="${candidate.value}"`;
    case 'xpath':
      return `xpath="${candidate.value}"`;
  }
}

/**
 * Walk a failed step's stored alternatives in order.
 *
 * Returns null when healing does not apply (step not locator-bearing, no
 * alternatives, or the error is not a locator failure). Otherwise returns an
 * attempt whose evidence records every alternative tried; `succeededWith` is
 * set only for the FIRST alternative with a unique (`=== 1`) match. A probe
 * returning `undefined` (unknown) never wins — unverified candidates stay
 * proposals-in-waiting, never silent switches.
 */
export function attemptHealing(
  step: TestStep,
  errorMessage: string,
  probe?: HealProbe,
): HealAttempt | null {
  const primary = step.target?.primary;
  const alternatives = step.target?.alternatives ?? [];
  if (!primary) return null;
  if (!isLocatorBearingStep(step)) return null;
  if (alternatives.length === 0) return null;
  if (!isLocatorFailure(errorMessage ?? '')) return null;

  const startedAt = Date.now();
  const tried: string[] = [];
  for (const alt of alternatives) {
    tried.push(previewHealingCandidate(alt));
    let count: number | undefined;
    try {
      count = probe?.(alt);
    } catch {
      count = undefined; // a broken probe must not fail the run
    }
    if (count === 1) {
      return {
        stepId: step.id,
        fromLocator: primary,
        evidence: {
          tried,
          succeededWith: alt,
          matchCount: 1,
          preview: previewHealingCandidate(alt),
          verified: true,
          durationMs: Date.now() - startedAt,
          reason: 'locator-timeout',
        },
      };
    }
  }
  return {
    stepId: step.id,
    fromLocator: primary,
    evidence: {
      tried,
      verified: false,
      durationMs: Date.now() - startedAt,
      reason: 'locator-timeout',
    },
  };
}
