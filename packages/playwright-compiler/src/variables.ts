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

/** A fragment of a string split into literal text vs variable reference. */
export type TemplatePart =
  | { kind: 'text'; value: string }
  | { kind: 'variable'; name: string };

/** Split a raw string into literal/variable parts. Deterministic, no I/O. */
export function parseTemplate(value: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  VARIABLE_PATTERN.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = VARIABLE_PATTERN.exec(value)) !== null) {
    if (m.index > last) parts.push({ kind: 'text', value: value.slice(last, m.index) });
    parts.push({ kind: 'variable', name: m[1] });
    last = m.index + m[0].length;
  }
  if (last < value.length) parts.push({ kind: 'text', value: value.slice(last) });
  // Reset global-regex state for the shared pattern.
  VARIABLE_PATTERN.lastIndex = 0;
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

/** True when `value` contains at least one `{{NAME}}` reference. */
export function hasVariable(value: string): boolean {
  SINGLE_VARIABLE_PATTERN.lastIndex = 0;
  VARIABLE_PATTERN.lastIndex = 0;
  return VARIABLE_PATTERN.test(value);
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
 * - mixed text -> `` `prefix${process.env.NAME}suffix` ``
 *
 * Never reads `process.env` at compile time, so secrets cannot leak into output.
 */
export function compileValueExpression(value: string): string {
  const single = SINGLE_VARIABLE_PATTERN.exec(value);
  if (single) return `process.env.${single[1]}!`;

  const parts = parseTemplate(value);
  const hasVar = parts.some((p) => p.kind === 'variable');
  if (!hasVar) return stringLiteral(value);

  const body = parts
    .map((p) =>
      p.kind === 'variable' ? `\${process.env.${p.name}}` : escapeTemplateText(p.value),
    )
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
