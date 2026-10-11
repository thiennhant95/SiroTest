/**
 * P2 — JUnit XML import (migration aid, symmetric with JUnit export).
 *
 * JUnit carries names + outcomes, NOT steps — so every `<testcase>` becomes
 * a DRAFT shell test (empty steps, like a blank Builder test) carrying the
 * original classname/status/failure text in its description. Shells are
 * unrunnable until steps are recorded; nothing is fabricated, and every
 * lossy mapping is returned in `warnings[]` (never silent).
 *
 * Dependency-free minimal parser: handles `<testsuites>`/`<testsuite>` roots,
 * self-closing and body `<testcase>` elements, `<failure>`/`<error>` (→
 * failed) and `<skipped>` children, XML entities + CDATA. Anything else in
 * the file (properties, system-out/err) is ignored by design.
 */

export type JunitImportStatus = 'passed' | 'failed' | 'skipped';

export interface JunitImportCase {
  /** Display name (`classname :: name`, or bare name). */
  name: string;
  classname: string;
  caseName: string;
  status: JunitImportStatus;
  timeSeconds: number | null;
  /** Short failure/error/skipped message (attribute or body, trimmed). */
  message: string | null;
}

export interface JunitImportDocument {
  suiteName: string | null;
  cases: JunitImportCase[];
}

export class JunitParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JunitParseError';
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : _m;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => {
      const code = parseInt(h as string, 16);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : _m;
    });
}

function attr(tag: string, name: string): string | null {
  // Boundary-aware: `name=` must not match inside `classname=` etc.
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  if (!m) return null;
  return decodeEntities(m[1] ?? m[2] ?? '');
}

/**
 * Parse a JUnit XML document. Throws {@link JunitParseError} when the text
 * is not a JUnit document at all (no testsuite root) or carries zero
 * `<testcase>` elements (callers map these to 400 / 422 respectively).
 */
export function parseJunitXml(xml: string): JunitImportDocument {
  const noComments = xml.replace(/<!--[\s\S]*?-->/g, '');
  if (!/<testsuites?[\s>]/.test(noComments)) {
    throw new JunitParseError('not a JUnit XML document (no <testsuite> root found)');
  }
  const suiteMatch = /<testsuite\b([^>]*)>/.exec(noComments);
  const suiteName = suiteMatch ? attr(suiteMatch[1] ?? '', 'name') : null;

  const cases: JunitImportCase[] = [];
  // Single document-order pass: each `<testcase …>` open tag is either
  // self-closing (`…/>`) or followed by a body up to `</testcase>`.
  // The attr span tolerates `>` inside quoted values.
  const openRe = /<testcase\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m: RegExpExecArray | null;
  const push = (attrText: string, body: string | null) => {
    const classname = (attr(attrText, 'classname') ?? '').trim();
    const caseName = (attr(attrText, 'name') ?? '').trim();
    if (!caseName) return; // nameless case: drop explicitly (counted by caller via warnings)
    const timeRaw = attr(attrText, 'time');
    const timeSeconds = timeRaw !== null && timeRaw !== '' && Number.isFinite(Number(timeRaw)) ? Number(timeRaw) : null;
    let status: JunitImportStatus = 'passed';
    let message: string | null = null;
    if (body !== null) {
      const fail = /<(failure|error)\b([^>]*)>([\s\S]*?)<\/(failure|error)>/.exec(body)
        ?? /<(failure|error)\b([^>]*)\/>/.exec(body);
      const skip = /<skipped\b([^>]*)(?:>([\s\S]*?)<\/skipped>|\/>)/.exec(body);
      if (fail) {
        status = 'failed';
        const msgAttr = attr(fail[2] ?? '', 'message');
        const text = decodeEntities(
          (fail[3] ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ''),
        ).trim();
        message = (msgAttr || text || 'failed').slice(0, 2000);
      } else if (skip) {
        status = 'skipped';
        const msgAttr = attr(skip[1] ?? '', 'message');
        const text = decodeEntities(
          (skip[2] ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ''),
        ).trim();
        message = (msgAttr || text || null)?.slice(0, 2000) ?? null;
      }
    }
    const name = classname ? `${classname} :: ${caseName}` : caseName;
    cases.push({ name, classname, caseName, status, timeSeconds, message });
  };
  while ((m = openRe.exec(noComments)) !== null) {
    const full = m[0];
    const inner = (m[1] ?? '').trim();
    if (full.endsWith('/>')) {
      push(inner.replace(/\s*\/$/, ''), null);
    } else {
      const bodyStart = (m.index ?? 0) + full.length;
      const closeIdx = noComments.indexOf('</testcase>', bodyStart);
      if (closeIdx === -1) continue; // unclosed: drop explicitly, never half-parse
      push(inner, noComments.slice(bodyStart, closeIdx));
      openRe.lastIndex = closeIdx + '</testcase>'.length;
    }
  }

  if (cases.length === 0) {
    throw new JunitParseError('JUnit document has no <testcase> elements with names');
  }
  return { suiteName, cases };
}
