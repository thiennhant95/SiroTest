/**
 * Candidate -> Playwright expression string.
 * Mapping follows 06-compiler/playwright-compiler.md:
 *   role -> getByRole | label -> getByLabel | placeholder -> getByPlaceholder
 *   testId -> getByTestId | text -> getByText | css/xpath -> locator()
 */
import type {
  LocatorCandidate,
  ResolvedLocator,
  ScoredCandidate,
} from './types';

/** Quote for single-quoted TS string literals in generated code. */
function q(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function candidateToExpression(
  candidate: LocatorCandidate,
  pageVar = 'page',
): string {
  switch (candidate.strategy) {
    case 'role': {
      const opts = candidate.name
        ? `, { name: ${q(candidate.name)}${candidate.exact ? ', exact: true' : ''} }`
        : '';
      return `${pageVar}.getByRole(${q(candidate.role)}${opts})`;
    }
    case 'label':
      return `${pageVar}.getByLabel(${q(candidate.value)}${
        candidate.exact ? ', { exact: true }' : ''
      })`;
    case 'placeholder':
      return `${pageVar}.getByPlaceholder(${q(candidate.value)}${
        candidate.exact ? ', { exact: true }' : ''
      })`;
    case 'testId':
      return `${pageVar}.getByTestId(${q(candidate.value)})`;
    case 'text':
      return `${pageVar}.getByText(${q(candidate.value)}${
        candidate.exact ? ', { exact: true }' : ''
      })`;
    case 'css':
    case 'xpath':
      return `${pageVar}.locator(${q(candidate.value)})`;
  }
}

/** Short human-readable summary, e.g. `role=button name="Login"`. */
export function previewCandidate(candidate: LocatorCandidate): string {
  switch (candidate.strategy) {
    case 'role':
      return candidate.name
        ? `role=${candidate.role} name="${candidate.name}"`
        : `role=${candidate.role}`;
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
 * Multi-line readable preview for pickers/logs:
 * primary expression + match count + scored alternatives table.
 */
export function formatResolvedLocator(
  resolved: ResolvedLocator,
  ranked?: ScoredCandidate[],
): string {
  const lines: string[] = [];
  lines.push(`primary: ${candidateToExpression(resolved.primary)}`);
  lines.push(`  (${previewCandidate(resolved.primary)})`);
  lines.push(
    resolved.verified
      ? `matches: ${resolved.matchCount} (verified in browser)`
      : `matches: ~${resolved.matchCount} (unverified — assumed unique; run Test Locator)`,
  );
  if (ranked && ranked.length > 1) {
    lines.push(
      `score table: ${ranked
        .map(
          (r) =>
            `[${r.score}] ${previewCandidate(r.candidate)}` +
            (r.matchCount !== undefined ? ` (x${r.matchCount})` : ''),
        )
        .join(' | ')}`,
  );
  }
  if (resolved.alternatives.length > 0) {
    lines.push('alternatives (stored only — P0 never auto-switches):');
    for (const alt of resolved.alternatives) {
      lines.push(`  - ${candidateToExpression(alt)}`);
    }
  } else {
    lines.push('alternatives: (none)');
  }
  return lines.join('\n');
}
