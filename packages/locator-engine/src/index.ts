/**
 * Public entry point of @playwright-vv/locator-engine (P0).
 *
 * P0 contract:
 * - resolveLocator() returns primary + alternatives + matchCount + preview.
 * - The runner executes ONLY primary (pickPrimaryForExecution).
 * - Alternatives are evidence for explicit/auditable P2 healing; the engine
 *   itself never switches locators at runtime.
 * - testLocatorMatch() implements "Test Locator" 0/1/N semantics.
 */
import type {
  LocatorCandidate,
  TestLocatorResult,
} from './types';

export * from './types';
export * from './scoring';
export * from './candidates';
export * from './toExpression';

export interface TestLocatorOptions {
  /** Set true when the action/assertion legitimately permits multiple matches. */
  allowMultiple?: boolean;
}

/**
 * "Test Locator": map a measured DOM match count to 0/1/N semantics.
 * - 0 -> status 'none', step cannot be saved as healthy.
 * - 1 -> status 'unique', healthy.
 * - N -> status 'ambiguous', warning unless allowMultiple.
 */
export function testLocatorMatch(
  matchCount: number,
  opts: TestLocatorOptions = {},
): TestLocatorResult {
  if (!Number.isInteger(matchCount) || matchCount < 0) {
    throw new Error(
      `testLocatorMatch: matchCount must be a non-negative integer, got ${matchCount}.`,
    );
  }
  if (matchCount === 0) {
    return {
      matchCount,
      status: 'none',
      canSave: false,
      message: 'Locator matches 0 elements — step cannot be saved as healthy.',
    };
  }
  if (matchCount === 1) {
    return {
      matchCount,
      status: 'unique',
      canSave: true,
      message: 'Locator matches exactly 1 element.',
    };
  }
  const allowMultiple = opts.allowMultiple ?? false;
  return {
    matchCount,
    status: 'ambiguous',
    canSave: true,
    warning: allowMultiple
      ? undefined
      : `Locator matches ${matchCount} elements — ambiguous; refine it unless the action/assertion permits multiple.`,
    message: `Locator matches ${matchCount} elements.`,
  };
}

/**
 * P0 execution gate: always return the stored primary.
 * No fallback to alternatives here — self-healing is forbidden in P0
 * (P2 healing must be explicit and auditable).
 */
export function pickPrimaryForExecution(spec: {
  primary: LocatorCandidate;
  alternatives?: LocatorCandidate[];
}): LocatorCandidate {
  return spec.primary;
}
