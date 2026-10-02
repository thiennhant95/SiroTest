/**
 * Variable handling for the P0 compiler.
 *
 * Rule (per 06-compiler/playwright-compiler.md):
 * - `{{NAME}}` references compile to a runtime env lookup (`process.env.NAME`).
 * - Secret values are NEVER inlined into generated code.
 * - Values are resolved at run time and must be redacted from logs by the runner.
 */

/** Matches `{{ NAME }}` placeholders. NAME must be a valid env identifier. */
export const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

const SINGLE_VARIABLE_PATTERN = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

/**
 * Matches `{{ row.NAME }}` dataset-row placeholders (P1 data-driven runs).
 * NAME must be a valid identifier (dataset column names are validated at
 * import time to match this shape so every reference compiles safely).
 */
export const ROW_PATTERN = /\{\{\s*row\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

const SINGLE_ROW_PATTERN = /^\{\{\s*row\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

/**
 * P1 security note: dataset rows are PLAIN strings embedded in the test
 * definition (visible to anyone who can read the test). Secrets MUST use
 * `{{VARIABLE}}` (resolved at run time, redacted everywhere) — NEVER
 * dataset rows. This constant is embedded as a comment in data-driven
 * output and rendered as a UI hint in the Datasets tab; tests assert it.
 */
export const DATASET_SECRET_NOTE =
  'Dataset rows are plaintext — never put secrets in datasets, use {{VARIABLES}} instead.';

/** A fragment of a string split into literal text vs variable/row reference. */
export type TemplatePart =
  | { kind: 'text'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'row'; name: string };

/** Split a raw string into literal/variable/row parts. Deterministic, no I/O. */
export function parseTemplate(value: string): TemplatePart[] {
  const combined = /\{\{\s*(row\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  const parts: TemplatePart[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = combined.exec(value)) !== null) {
    if (m.index > last) parts.push({ kind: 'text', value: value.slice(last, m.index) });
    parts.push(m[1] ? { kind: 'row', name: m[2] } : { kind: 'variable', name: m[2] });
    last = m.index + m[0].length;
  }
  if (last < value.length) parts.push({ kind: 'text', value: value.slice(last) });
  // Reset shared global-regex state.
  VARIABLE_PATTERN.lastIndex = 0;
  ROW_PATTERN.lastIndex = 0;
  return parts;
}

/** Return ordered unique variable names referenced by `value`. */
export function extractVariableNames(value: string): string[] {
  const seen = new Set<string>();
  for (const p of parseTemplate(value)) {
    if (p.kind === 'variable') seen.add(p.name);
  }
  return [...seen];
}

/** Return ordered unique dataset-row column names (`{{row.NAME}}`). */
export function extractRowNames(value: string): string[] {
  const seen = new Set<string>();
  for (const p of parseTemplate(value)) {
    if (p.kind === 'row') seen.add(p.name);
  }
  return [...seen];
}

/** True when `value` contains at least one `{{NAME}}` reference. */
export function hasVariable(value: string): boolean {
  SINGLE_VARIABLE_PATTERN.lastIndex = 0;
  VARIABLE_PATTERN.lastIndex = 0;
  return VARIABLE_PATTERN.test(value);
}

/** True when `value` contains at least one `{{row.NAME}}` reference. */
export function hasRowReference(value: string): boolean {
  SINGLE_ROW_PATTERN.lastIndex = 0;
  ROW_PATTERN.lastIndex = 0;
  return ROW_PATTERN.test(value);
}

/**
 * Escape a string for safe embedding in a single-quoted TS literal.
 * Handles backslashes, single quotes, and control characters.
 */
export function escapeString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\0/g, '\\0');
}

/** Wrap an escaped payload in single quotes. */
export function stringLiteral(value: string): string {
  return `'${escapeString(value)}'`;
}

/** Escape literal text for embedding inside a template literal. */
function escapeTemplateText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * Compile a user-facing string (URL, fill value, assertion expectation, ...)
 * into a TS expression:
 * - plain text -> `'literal'`
 * - whole-string `{{NAME}}` -> `process.env.NAME!` (required at runtime)
 * - whole-string `{{row.NAME}}` -> `(row["NAME"] ?? '')` (iteration context;
 *   only valid inside the dataset loop emitted by `compileTest`, which always
 *   declares `row` — missing columns fall back to `''`, never `undefined`)
 * - mixed text -> `` `prefix${process.env.NAME}…${(row["COL"] ?? '')}suffix` ``
 *
 * Never reads `process.env` at compile time, so secrets cannot leak into output.
 * Dataset rows are plaintext by design (see DATASET_SECRET_NOTE) — that is why
 * a `sensitive` fill containing only a `{{row.*}}` reference still fails the
 * compiler's sensitive check (it is not a `{{VARIABLE}}`): secrets must come
 * from variables, never from rows.
 */
export function compileValueExpression(value: string): string {
  const singleVar = SINGLE_VARIABLE_PATTERN.exec(value);
  if (singleVar) return `process.env.${singleVar[1]}!`;
  const singleRow = SINGLE_ROW_PATTERN.exec(value);
  if (singleRow) return `(row[${stringLiteral(singleRow[1])}] ?? '')`;

  const parts = parseTemplate(value);
  const hasVar = parts.some((p) => p.kind === 'variable' || p.kind === 'row');
  if (!hasVar) return stringLiteral(value);

  const body = parts
    .map((p) => {
      if (p.kind === 'variable') return `\${process.env.${p.name}}`;
      if (p.kind === 'row') return `\${(row[${stringLiteral(p.name)}] ?? '')}`;
      return escapeTemplateText(p.value);
    })
    .join('');
  return `\`${body}\``;
}

/**
 * Redact known secret values from a log line. The compiler itself never sees
 * secret values; the runner applies this to runtime logs.
 */
export function redactSecrets(log: string, secretNames: string[], env: NodeJS.ProcessEnv = {}): string {
  let out = log;
  for (const name of secretNames) {
    const secret = env[name];
    if (secret) out = out.split(secret).join('***');
    // Always redact the lookup shape too, in case it was echoed.
    out = out.split(`process.env.${name}`).join('process.env.***');
  }
  return out;
}
