/**
 * Locator Engine P0 — canonical types.
 *
 * `LocatorCandidate` reuses 03-test-model/test-definition.md verbatim so the
 * engine output plugs directly into `LocatorSpec { primary, alternatives }`.
 * P0 executes ONLY `primary`; `alternatives` are stored evidence for
 * explicit/auditable P2 healing (never silently switched at runtime).
 */

export type LocatorCandidate =
  | { strategy: 'role'; role: string; name?: string; exact?: boolean }
  | { strategy: 'label'; value: string; exact?: boolean }
  | { strategy: 'placeholder'; value: string; exact?: boolean }
  | { strategy: 'testId'; value: string }
  | { strategy: 'text'; value: string; exact?: boolean }
  | { strategy: 'css'; value: string }
  | { strategy: 'xpath'; value: string };

/**
 * Minimal element metadata. The recorder bridge sends this (never trusts raw
 * selector strings from page JS); server-side code may enrich it via
 * Playwright DOM/ARIA evaluation (see 04-recorder/recorder-spec.md).
 */
export interface ElementMetadata {
  tagName: string;
  role?: string;
  accessibleName?: string;
  label?: string;
  placeholder?: string;
  /** Value of `data-testid` (or configured test-id attribute). */
  testId?: string;
  /** Visible text content, whitespace-collapsed by the engine. */
  text?: string;
  id?: string;
  classNames?: string[];
  attributes?: Record<string, string>;
  /** Full CSS chain evaluated from the DOM (may be long/unstable). */
  cssPath?: string;
  xpath?: string;
}

export interface ScoredCandidate {
  candidate: LocatorCandidate;
  score: number;
  reasons: string[];
  matchCount?: number;
}

/** Engine output: primary + alternatives + match count + readable preview. */
export interface ResolvedLocator {
  primary: LocatorCandidate;
  alternatives: LocatorCandidate[];
  matchCount: number;
  preview: string;
  /** False when no browser counter was supplied (counts assumed unique). */
  verified: boolean;
}

export type MatchStatus = 'none' | 'unique' | 'ambiguous';

/**
 * Result of "Test Locator" (05-locator/locator-engine.md): given an active
 * browser session, a candidate yields 0 / 1 / N matches. A step cannot be
 * saved as healthy on 0; N shows a warning unless multi-match is allowed.
 */
export interface TestLocatorResult {
  matchCount: number;
  status: MatchStatus;
  canSave: boolean;
  warning?: string;
  message: string;
}

/** Counts DOM matches for a candidate inside an active browser session. */
export type GetMatchCount = (candidate: LocatorCandidate) => number | undefined;
