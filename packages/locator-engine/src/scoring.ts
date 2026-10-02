/**
 * Candidate scoring (05-locator/locator-engine.md).
 *
 * Priority (not absolute — uniqueness can override it):
 *   Role+name > Label > Placeholder > TestId > Text (stable)
 *     > CSS (stable) > XPath (fallback)
 *
 * Adjustments:
 *   + unique match / semantic-accessible / explicit test-id / stable short text
 *   - zero match / ambiguous match / dynamic id-class / nth-child /
 *     long DOM chain / xpath fallback
 */
import type { LocatorCandidate, ScoredCandidate, GetMatchCount } from './types';

export const PRIORITY_ORDER = [
  'role',
  'label',
  'placeholder',
  'testId',
  'text',
  'css',
  'xpath',
] as const;

/** All scoring numbers in one place — quoted in reports/PRs, asserted in tests. */
export const SCORING_RULES = {
  base: {
    roleWithName: 100,
    label: 90,
    placeholder: 80,
    testId: 70,
    roleWithoutName: 65,
    text: 60,
    css: 40,
    xpath: 10,
  },
  bonus: {
    uniqueMatch: 30,
    semanticAccessible: 10,
    explicitTestId: 15,
    stableShortText: 10,
  },
  penalty: {
    zeroMatch: -50,
    ambiguousMatch: -20,
    dynamicToken: -25,
    nthChild: -30,
    longDomChain: -30,
    xpathFallback: -20,
  },
} as const;

/** Heuristic patterns for framework-generated / unstable tokens. */
const DYNAMIC_PATTERNS: RegExp[] = [
  /[0-9a-f]{32,}/i, // md5/sha hashes
  /[0-9a-f]{8}-[0-9a-f]{4}-/i, // uuids
  /\d{4,}/, // long numeric runs (timestamps, increments)
  /css-[a-z0-9]{4,}/i, // emotion / styled
  /emotion/i,
  /styled/i,
  /mui-[a-z]+-\d+/i, // mui generated classes
  /:r\d+:/, // react aria generated ids
  /__[a-z0-9]{4,}/i, // css-module hashes
  /--[a-z0-9]{5,}/i, // hashed suffixes
];

export function isDynamicToken(token: string): boolean {
  if (!token) return false;
  if (DYNAMIC_PATTERNS.some((re) => re.test(token))) return true;
  const compact = token.replace(/[^a-z0-9]/gi, '');
  return (
    compact.length >= 8 &&
    /[a-z]/i.test(compact) &&
    /\d/.test(compact) &&
    /[0-9a-f]{6,}/i.test(compact)
  );
}

/** Short, single-line, number-stable text is safe for getByText. */
export function isStableText(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 50) return false;
  if (/[\r\n]/.test(t)) return false;
  if (/\d{4,}/.test(t)) return false;
  return true;
}

/** Number of compound selectors, e.g. "form > div input" -> 3. */
export function cssDepth(selector: string): number {
  return selector.split(/[\s>+~]+/).filter(Boolean).length;
}

export function hasNth(selector: string): boolean {
  return /:nth-(child|of-type)\(/i.test(selector);
}

/** Deterministic key for dedupe / match-count lookup / stable tie-break. */
export function candidateKey(c: LocatorCandidate): string {
  switch (c.strategy) {
    case 'role':
      return `role|${c.role}|${c.name ?? ''}|${c.exact ? 'exact' : 'fuzzy'}`;
    case 'label':
      return `label|${c.value}|${c.exact ? 'exact' : 'fuzzy'}`;
    case 'placeholder':
      return `placeholder|${c.value}|${c.exact ? 'exact' : 'fuzzy'}`;
    case 'testId':
      return `testId|${c.value}`;
    case 'text':
      return `text|${c.value}|${c.exact ? 'exact' : 'fuzzy'}`;
    case 'css':
      return `css|${c.value}`;
    case 'xpath':
      return `xpath|${c.value}`;
  }
}

export interface ScoreOptions {
  matchCount?: number;
}

export function scoreCandidate(
  candidate: LocatorCandidate,
  opts: ScoreOptions = {},
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const R = SCORING_RULES;
  let score = 0;

  // 1. Base priority.
  switch (candidate.strategy) {
    case 'role':
      if (candidate.name) {
        score += R.base.roleWithName;
        reasons.push(`base role+name +${R.base.roleWithName}`);
      } else {
        score += R.base.roleWithoutName;
        reasons.push(`base role (no name) +${R.base.roleWithoutName}`);
      }
      break;
    case 'label':
      score += R.base.label;
      reasons.push(`base label +${R.base.label}`);
      break;
    case 'placeholder':
      score += R.base.placeholder;
      reasons.push(`base placeholder +${R.base.placeholder}`);
      break;
    case 'testId':
      score += R.base.testId;
      reasons.push(`base testId +${R.base.testId}`);
      break;
    case 'text':
      score += R.base.text;
      reasons.push(`base text +${R.base.text}`);
      break;
    case 'css':
      score += R.base.css;
      reasons.push(`base css +${R.base.css}`);
      break;
    case 'xpath':
      score += R.base.xpath;
      reasons.push(`base xpath +${R.base.xpath}`);
      break;
  }

  // 2. Semantic / explicit-id / stable-text bonuses.
  if (
    candidate.strategy === 'role' ||
    candidate.strategy === 'label' ||
    candidate.strategy === 'placeholder'
  ) {
    score += R.bonus.semanticAccessible;
    reasons.push(`semantic/accessible +${R.bonus.semanticAccessible}`);
  }
  if (candidate.strategy === 'testId') {
    score += R.bonus.explicitTestId;
    reasons.push(`explicit test id +${R.bonus.explicitTestId}`);
  }
  if (candidate.strategy === 'text' && isStableText(candidate.value)) {
    score += R.bonus.stableShortText;
    reasons.push(`stable short text +${R.bonus.stableShortText}`);
  }

  // 3. Uniqueness (measured in browser; skipped when unknown).
  const mc = opts.matchCount;
  if (mc !== undefined) {
    if (mc === 1) {
      score += R.bonus.uniqueMatch;
      reasons.push(`unique match +${R.bonus.uniqueMatch}`);
    } else if (mc === 0) {
      score += R.penalty.zeroMatch;
      reasons.push(`zero match ${R.penalty.zeroMatch}`);
    } else {
      score += R.penalty.ambiguousMatch;
      reasons.push(`ambiguous (${mc} matches) ${R.penalty.ambiguousMatch}`);
    }
  }

  // 4. Dynamic-looking id/class penalty.
  const dynamicTargets: string[] =
    candidate.strategy === 'testId' || candidate.strategy === 'css'
      ? [candidate.value]
      : [];
  if (dynamicTargets.some(isDynamicToken)) {
    score += R.penalty.dynamicToken;
    reasons.push(`dynamic-looking id/class ${R.penalty.dynamicToken}`);
  }

  // 5. nth-child / nth-of-type strong penalty (brittle under re-order).
  if (
    (candidate.strategy === 'css' || candidate.strategy === 'xpath') &&
    hasNth(candidate.value)
  ) {
    score += R.penalty.nthChild;
    reasons.push(`nth-child/nth-of-type ${R.penalty.nthChild}`);
  }

  // 6. Long DOM chain strong penalty.
  if (candidate.strategy === 'css') {
    if (cssDepth(candidate.value) > 4 || candidate.value.length > 80) {
      score += R.penalty.longDomChain;
      reasons.push(`long DOM chain ${R.penalty.longDomChain}`);
    }
  }
  if (candidate.strategy === 'xpath') {
    const steps = candidate.value.split('/').filter(Boolean).length;
    if (steps > 5 || candidate.value.length > 100) {
      score += R.penalty.longDomChain;
      reasons.push(`long DOM chain ${R.penalty.longDomChain}`);
    }
    // 7. XPath is fallback-only.
    score += R.penalty.xpathFallback;
    reasons.push(`xpath fallback ${R.penalty.xpathFallback}`);
  }

  return { score, reasons };
}

/**
 * Score + deterministic rank. Tie-break: priority order, then candidate key
 * (so output is stable across runs for the same input).
 */
export function rankCandidates(
  candidates: LocatorCandidate[],
  getMatchCount?: GetMatchCount,
): ScoredCandidate[] {
  const order = new Map<string, number>(
    PRIORITY_ORDER.map((s, i) => [s, i]),
  );
  const scored: ScoredCandidate[] = candidates.map((candidate) => {
    const matchCount = getMatchCount?.(candidate);
    const { score, reasons } = scoreCandidate(candidate, { matchCount });
    return { candidate, score, reasons, matchCount };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const oa = order.get(a.candidate.strategy) ?? 99;
    const ob = order.get(b.candidate.strategy) ?? 99;
    if (oa !== ob) return oa - ob;
    return candidateKey(a.candidate) < candidateKey(b.candidate) ? -1 : 1;
  });
  return scored;
}
