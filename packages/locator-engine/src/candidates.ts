/**
 * Candidate generation from element metadata + resolution to
 * primary/alternatives (05-locator/locator-engine.md).
 */
import type {
  ElementMetadata,
  GetMatchCount,
  LocatorCandidate,
  ResolvedLocator,
  ScoredCandidate,
} from './types';
import { candidateKey, isDynamicToken, rankCandidates } from './scoring';
import { formatResolvedLocator } from './toExpression';

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Prefer a short stable CSS hook; fall back to the raw evaluated cssPath. */
function stableCssFor(meta: ElementMetadata): string | undefined {
  const tag = meta.tagName.toLowerCase();
  if (meta.id && !isDynamicToken(meta.id)) return `#${meta.id}`;
  const attrs = meta.attributes ?? {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('data-') && v && !isDynamicToken(v)) {
      return `${tag}[${k}="${v}"]`;
    }
  }
  const stableClass = (meta.classNames ?? []).find(
    (c) => !!c && !/\s/.test(c) && !isDynamicToken(c),
  );
  if (stableClass) return `${tag}.${stableClass}`;
  return undefined;
}

/**
 * Emit candidates in priority order:
 * role+name > label > placeholder > testId > role (no name) > text > css > xpath.
 * Role-without-name ranks below testId (see scoring base 65 < 70).
 */
export function buildCandidates(meta: ElementMetadata): LocatorCandidate[] {
  const out: LocatorCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: LocatorCandidate): void => {
    const k = candidateKey(c);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(c);
    }
  };

  if (meta.role && collapseWhitespace(meta.accessibleName ?? '')) {
    push({
      strategy: 'role',
      role: meta.role,
      name: collapseWhitespace(meta.accessibleName as string),
    });
  }
  if (collapseWhitespace(meta.label ?? '')) {
    push({ strategy: 'label', value: collapseWhitespace(meta.label as string) });
  }
  if (collapseWhitespace(meta.placeholder ?? '')) {
    push({
      strategy: 'placeholder',
      value: collapseWhitespace(meta.placeholder as string),
    });
  }
  if (collapseWhitespace(meta.testId ?? '')) {
    push({ strategy: 'testId', value: collapseWhitespace(meta.testId as string) });
  }
  if (meta.role && !collapseWhitespace(meta.accessibleName ?? '')) {
    push({ strategy: 'role', role: meta.role });
  }
  const text = collapseWhitespace(meta.text ?? '');
  if (text && text.length <= 100) {
    push({ strategy: 'text', value: text });
  }
  const stableCss = stableCssFor(meta);
  if (stableCss) push({ strategy: 'css', value: stableCss });
  const rawCss = collapseWhitespace(meta.cssPath ?? '');
  if (rawCss && rawCss !== stableCss) push({ strategy: 'css', value: rawCss });
  if (collapseWhitespace(meta.xpath ?? '')) {
    push({ strategy: 'xpath', value: collapseWhitespace(meta.xpath as string) });
  }
  return out;
}

/**
 * Score all candidates, pick the top as primary, keep the rest as
 * alternatives (stored evidence — P0 executes primary only, never heals).
 *
 * Without a browser counter, every candidate is assumed unique and the
 * result is marked `verified: false`; use Test Locator (testLocatorMatch)
 * against a live session before saving the step as healthy.
 */
export function resolveLocator(
  meta: ElementMetadata,
  getMatchCount?: GetMatchCount,
): ResolvedLocator {
  const candidates = buildCandidates(meta);
  if (candidates.length === 0) {
    throw new Error(
      'resolveLocator: element metadata produced no candidates ' +
        '(need at least one of role/label/placeholder/testId/text/css/xpath).',
    );
  }
  const ranked: ScoredCandidate[] = rankCandidates(candidates, getMatchCount);
  const [top, ...rest] = ranked;
  const verified = getMatchCount !== undefined;
  const resolved: ResolvedLocator = {
    primary: top.candidate,
    alternatives: rest.map((r) => r.candidate),
    matchCount: top.matchCount ?? 1,
    preview: '',
    verified,
  };
  resolved.preview = formatResolvedLocator(resolved, ranked);
  return resolved;
}
