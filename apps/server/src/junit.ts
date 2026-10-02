/**
 * P1 — JUnit XML export (`CLI/CI trigger and JUnit export`).
 *
 * Pure helper: builds a JUnit `<testsuites>` document from run records.
 * - XML-escapes every free-text field (names, messages, error bodies).
 * - Redacts known secret values (passed explicitly by the caller) so secret
 *   plaintext can never leak into CI-consumed XML, even if a stored summary
 *   somehow still carries it (defense-in-depth; the runner already redacts
 *   at settle time and the route re-redacts with decrypted server values).
 * - Never emits absolute server paths: callers must pass already-stripped
 *   text (the route applies `stripServerPaths` before calling in).
 */
import { REDACTED, redactSecretsText } from './security.js';

export interface JunitCase {
  /** Test/display name, e.g. the Test name. */
  name: string;
  /** Grouping class, e.g. suite name or project name. */
  classname: string;
  /** Run status: passed | failed | cancelled | queued | running. */
  status: string;
  /** Duration in milliseconds (optional). */
  durationMs?: number | null;
  /** Short failure message (optional). */
  message?: string | null;
  /** Full failure body, e.g. errorSummary (optional). */
  body?: string | null;
  /** Which attempt this case represents (1 = first try). */
  attempt?: number;
}

export interface JunitOptions {
  /** Plaintext secrets to scrub (server decrypts in-memory, never emits). */
  secrets?: string[];
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function scrub(text: string, secrets: string[]): string {
  const redacted = redactSecretsText(text, secrets);
  return escapeXml(redacted);
}

/**
 * Build a JUnit XML document.
 * Non-passed terminal states map to `<failure>` (failed) or `<skipped>`
 * (cancelled); non-terminal runs are emitted as `<skipped>` with an explicit
 * message so CI never silently counts them as passed.
 */
export function buildJunitXml(
  suiteName: string,
  cases: JunitCase[],
  opts: JunitOptions = {},
): string {
  const secrets = opts.secrets ?? [];
  const safeSuite = scrub(suiteName, secrets);
  const failures = cases.filter((c) => c.status === 'failed').length;
  const skipped = cases.filter((c) => c.status !== 'passed' && c.status !== 'failed').length;
  const totalTime = cases.reduce((acc, c) => acc + (c.durationMs ?? 0) / 1000, 0);

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${cases.length}" failures="${failures}" skipped="${skipped}">`,
    `  <testsuite name="${safeSuite}" tests="${cases.length}" failures="${failures}" skipped="${skipped}" time="${totalTime.toFixed(3)}">`,
  ];
  for (const c of cases) {
    const name = scrub(c.name, secrets);
    const classname = scrub(c.classname, secrets);
    const time = ((c.durationMs ?? 0) / 1000).toFixed(3);
    const attempt = c.attempt !== undefined && c.attempt > 1 ? ` [attempt ${c.attempt}]` : '';
    lines.push(`    <testcase classname="${classname}" name="${name}${attempt}" time="${time}">`);
    if (c.status === 'failed') {
      const message = scrub(c.message ?? 'failed', secrets);
      const body = scrub(c.body ?? c.message ?? 'failed', secrets);
      lines.push(`      <failure message="${message}">${body}</failure>`);
    } else if (c.status !== 'passed') {
      const message = scrub(`run ${c.status}`, secrets);
      lines.push(`      <skipped message="${message}" />`);
    }
    lines.push('    </testcase>');
  }
  lines.push('  </testsuite>');
  lines.push('</testsuites>');
  return `${lines.join('\n')}\n`;
}

/** JUnit filename for a run / suite-run export (header-injection safe). */
export function junitFilename(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'run';
  return `${clean}.junit.xml`;
}

export { REDACTED };
