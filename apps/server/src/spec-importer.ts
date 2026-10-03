import { nanoid } from 'nanoid';

/**
 * P1 wave-2 — Playwright spec importer (feasible TypeScript SUBSET).
 *
 * Hand-written line-based parser (no TS compiler dependency — too heavy for
 * a best-effort draft import). Supported subset, one statement per line:
 *
 *   page.goto('https://…')
 *   page.getByRole('button', { name: 'Submit' }).click()
 *   page.getByLabel('Email').fill('a@b.c') / .dblclick() / .check()
 *   page.getByPlaceholder('Search').fill('…') / .press('Enter') / .hover()
 *   page.getByTestId('login-btn').click()
 *   page.getByText('Welcome').click()
 *   page.selectOption / .selectOption('v')  → select step
 *   expect(locator).toBeVisible()
 *   expect(locator).toHaveText('…') / .toContainText('…') / .toHaveValue('…')
 *   expect(page).toHaveURL('…') / .toHaveTitle('…')
 *   test.step('name', …) wrappers (header skipped; inner lines parse normally)
 *
 * Contract (no silent skips): every non-trivial line that does not match the
 * subset is reported in `warnings[]` as `line N: …` for user review. When
 * NOTHING maps to a step, parsing fails explicitly (SPEC_NO_STEPS → 422)
 * instead of creating an empty test.
 */

export interface SpecImportWarning {
  line: number;
  text: string;
}

export interface SpecImportDraft {
  /** Test name: explicit > first test()/test.step() title > 'Imported spec'. */
  name: string;
  definition: Record<string, unknown>;
  warnings: SpecImportWarning[];
  /** Raw mapped steps (same array embedded in definition.steps). */
  steps: Array<Record<string, unknown>>;
}

export class SpecParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecParseError';
  }
}

/** Extract a plain string literal ('…', "…", `…` without ${}); null otherwise. */
function stringLiteral(expr: string): string | null {
  const m = /^\s*('((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)\s*$/.exec(expr);
  if (!m) return null;
  const raw = m[2] ?? m[3] ?? m[4] ?? '';
  if (m[4] !== undefined && raw.includes('${')) return null; // interpolations unsupported
  return raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\`/g, '`').replace(/\\\\/g, '\\');
}

type LocatorTarget = Record<string, unknown>;

/** Parse `getByX(…)` (without the leading `page.`) into a P0 target. */
function parseLocator(expr: string): LocatorTarget | null {
  const m = /^\s*(getByRole|getByLabel|getByPlaceholder|getByTestId|getByText)\s*\((.*)\)\s*$/.exec(expr);
  if (!m) return null;
  const kind = m[1]!;
  const args = m[2]!.trim();
  // Split first arg (string/regex literal) from the options object.
  // No comma = single-arg form (getByLabel('Email')); rest stays empty.
  const firstEnd = findFirstArgEnd(args);
  const first = (firstEnd === -1 ? args : args.slice(0, firstEnd)).trim();
  const rest = (firstEnd === -1 ? '' : args.slice(firstEnd + 1)).trim();
  const literal = stringLiteral(first);
  const regexSource = literal === null ? regexLiteralSource(first) : null;
  const value = literal ?? regexSource;
  if (value === null) return null;
  switch (kind) {
    case 'getByRole': {
      const role = value;
      const nameMatch = /name\s*:\s*('((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|\/((?:[^/\\]|\\.)*)\/[a-z]*)/.exec(rest);
      let name: string | undefined;
      if (nameMatch) {
        name = nameMatch[2] ?? nameMatch[3] ?? nameMatch[4];
      }
      return {
        primary: {
          strategy: 'role',
          role,
          ...(name !== undefined ? { name } : {}),
        },
      };
    }
    case 'getByLabel':
      return { primary: { strategy: 'label', value } };
    case 'getByPlaceholder':
      return { primary: { strategy: 'placeholder', value } };
    case 'getByTestId':
      return { primary: { strategy: 'testId', value } };
    case 'getByText':
      return { primary: { strategy: 'text', value } };
    default:
      return null;
  }
}

/** Index of the comma ending the first argument, respecting quotes/regex. */
function findFirstArgEnd(args: string): number {
  let quote: string | null = null;
  let inRegex = false;
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (c === '\\') escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (inRegex) {
      if (c === '\\') escaped = true;
      else if (c === '/') inRegex = false;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '/' && i > 0 && !/[A-Za-z0-9_)\]]/.test(args[i - 1]!)) inRegex = true;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) return i;
  }
  return -1;
}

function regexLiteralSource(expr: string): string | null {
  const m = /^\s*\/((?:[^/\\]|\\.)*)\/[a-z]*\s*$/.exec(expr);
  return m ? m[1]! : null;
}

/** Split trailing `.method(args)` chain calls of a `page.…` expression. */
function splitChain(calls: string): Array<{ method: string; args: string }> {
  const out: Array<{ method: string; args: string }> = [];
  let i = 0;
  while (i < calls.length) {
    const m = /^\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(calls.slice(i));
    if (!m) break;
    const method = m[1]!;
    let j = i + m[0].length;
    let depth = 1;
    let quote: string | null = null;
    let escaped = false;
    while (j < calls.length && depth > 0) {
      const c = calls[j]!;
      if (escaped) escaped = false;
      else if (quote) {
        if (c === '\\') escaped = true;
        else if (c === quote) quote = null;
      } else if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      j++;
    }
    if (depth !== 0) return []; // unbalanced — caller treats as no-match
    out.push({ method, args: calls.slice(i + m[0].length, j - 1) });
    i = j;
  }
  return out;
}

const ACTION_TO_TYPE: Record<string, string> = {
  click: 'click',
  dblclick: 'doubleClick', // canonical P0 step name (test-model step-catalog)
  fill: 'fill',
  check: 'check',
  selectOption: 'select',
  press: 'press',
  hover: 'hover',
};

/** `{ value: 'x' }` / `{ label: 'x' }` object form of selectOption. */
function selectValue(args: string): string | null {
  const lit = stringLiteral(args);
  if (lit !== null) return lit;
  const m = /(value|label)\s*:\s*('((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/.exec(args);
  return m ? (m[3] ?? m[4] ?? null) : null;
}

function stepId(n: number): string {
  return `s${n}`;
}

/**
 * Map one trimmed code line to TestDefinition steps (empty = no match).
 * `counter` supplies 1-based step numbering via counter.count++.
 */
function mapLine(line: string, counter: { count: number }): Array<Record<string, unknown>> {
  // page.goto('url')
  let m = /^(?:await\s+)?page\.goto\(\s*(.+?)\s*\)\s*;?\s*$/.exec(line);
  if (m) {
    const url = stringLiteral(m[1]!);
    if (url === null) return [];
    return [{ id: stepId(counter.count++), type: 'goto', enabled: true, url }];
  }

  // page.<locator>.<action>(args)
  m = /^(?:await\s+)?page\.(getByRole|getByLabel|getByPlaceholder|getByTestId|getByText)\s*\(/.exec(line);
  if (m) {
    const afterPage = line.replace(/^(?:await\s+)?page\./, '');
    // Re-split: locator call = up to balanced ')' then the action chain.
    let depth = 0;
    let quote: string | null = null;
    let escaped = false;
    let end = -1;
    for (let i = 0; i < afterPage.length; i++) {
      const c = afterPage[i]!;
      if (escaped) escaped = false;
      else if (quote) {
        if (c === '\\') escaped = true;
        else if (c === quote) quote = null;
      } else if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) return [];
    const locatorExpr = afterPage.slice(0, end + 1);
    const chain = splitChain(afterPage.slice(end + 1).replace(/;\s*$/, ''));
    if (chain.length !== 1) return [];
    const target = parseLocator(locatorExpr);
    const call = chain[0]!;
    const type = ACTION_TO_TYPE[call.method];
    if (!target || !type) return [];
    const id = stepId(counter.count++);
    if (type === 'fill') {
      const value = stringLiteral(call.args);
      if (value === null) return [];
      return [{ id, type, enabled: true, target, value }];
    }
    if (type === 'select') {
      const value = selectValue(call.args.trim());
      if (value === null) return [];
      return [{ id, type, enabled: true, target, value }];
    }
    if (type === 'press') {
      const key = stringLiteral(call.args);
      if (key === null) return [];
      return [{ id, type, enabled: true, target, key }];
    }
    if (call.args.trim() !== '') return []; // click/dblclick/check/hover take no value
    return [{ id, type, enabled: true, target }];
  }

  // expect(<locator>).<assertion>(args) / expect(page).toHaveURL|Title('…')
  m = /^(?:await\s+)?expect\(\s*(.+?)\s*\)\s*(\.\s*[A-Za-z_][A-Za-z0-9_]*\s*\(.*\))\s*;?\s*$/.exec(line);
  if (m) {
    const subject = m[1]!.trim();
    const chain = splitChain(m[2]!);
    if (chain.length !== 1) return [];
    const call = chain[0]!;
    if (subject === 'page') {
      const expected = stringLiteral(call.args);
      if (expected === null) return [];
      if (call.method === 'toHaveURL') {
        return [{ id: stepId(counter.count++), type: 'assertURL', enabled: true, expected }];
      }
      if (call.method === 'toHaveTitle') {
        return [{ id: stepId(counter.count++), type: 'assertTitle', enabled: true, expected }];
      }
      return [];
    }
    const locatorOnPage = subject.startsWith('page.')
      ? subject.slice('page.'.length)
      : subject;
    const target = parseLocator(locatorOnPage);
    if (!target) return [];
    const id = stepId(counter.count++);
    switch (call.method) {
      case 'toBeVisible':
        if (call.args.trim() !== '') return [];
        return [{ id, type: 'assertVisible', enabled: true, target }];
      case 'toHaveText': {
        const expected = stringLiteral(call.args);
        return expected === null ? [] : [{ id, type: 'assertText', enabled: true, target, expected }];
      }
      case 'toContainText': {
        const expected = stringLiteral(call.args);
        return expected === null ? [] : [{ id, type: 'assertContainsText', enabled: true, target, expected }];
      }
      case 'toHaveValue': {
        const expected = stringLiteral(call.args);
        return expected === null ? [] : [{ id, type: 'assertValue', enabled: true, target, expected }];
      }
      default:
        return [];
    }
  }

  return [];
}

function firstTitle(code: string): string | null {
  const m = /(?:test|test\.step)\(\s*('((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/.exec(code);
  return m ? (m[2] ?? m[3] ?? null) : null;
}

function isSkippable(trimmed: string): boolean {
  if (trimmed === '') return true;
  if (trimmed.startsWith('//')) return true;
  if (/^import\s/.test(trimmed)) return true;
  if (/^(await\s+)?(test|test\.step)\s*\(/.test(trimmed)) return true; // suite/step headers
  if (/^async\s*\(\s*\)\s*=>\s*\{?\s*$/.test(trimmed)) return true;
  if (/^[{}]+\s*,?\s*$/.test(trimmed)) return true;
  if (/^\}\s*\)\s*;?\s*$/.test(trimmed)) return true; // closers: }); / })
  if (/^export\s*\{[^}]*\}\s*;?\s*$/.test(trimmed)) return true;
  // NOTE: anything else that does not map (e.g. const declarations, custom
  // helpers, page.locator chains) is a WARNING, never a silent skip.
  return false;
}

export function parsePlaywrightSpec(
  code: string,
  opts: { projectId: string; name?: string },
): SpecImportDraft {
  const steps: Array<Record<string, unknown>> = [];
  const warnings: SpecImportWarning[] = [];
  const counter = { count: 1 };
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (isSkippable(trimmed)) continue;
    const mapped = mapLine(trimmed, counter);
    if (mapped.length === 0) {
      warnings.push({ line: i + 1, text: `could not map to a P0 step (unsupported — skipped, review manually): ${trimmed.slice(0, 160)}` });
    } else {
      steps.push(...mapped);
    }
  }
  if (steps.length === 0) {
    throw new SpecParseError(
      `no mappable steps found in the ${lines.length}-line snippet (${warnings.length} unsupported line(s)) — supported: page.goto, getByRole/getByLabel/getByPlaceholder/getByTestId/getByText + click/dblclick/fill/check/selectOption/press/hover, expect().toBeVisible/toHaveText/toContainText/toHaveValue/toHaveURL/toHaveTitle`,
    );
  }
  const name = opts.name?.trim() || firstTitle(code) || 'Imported spec';
  const definition = {
    schemaVersion: '1.0',
    id: `test_${nanoid(10)}`,
    projectId: opts.projectId,
    name,
    browser: 'chromium',
    steps,
  };
  return { name, definition, warnings, steps };
}
