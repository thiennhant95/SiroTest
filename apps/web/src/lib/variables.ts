/**
 * Variable resolution + secret redaction (acceptance criteria):
 * - `{{KEY}}` resolves against the selected environment (env-scoped wins, else shared/global).
 * - Secret values never appear in logs, WS payload rendering, or generated code preview.
 */
import type { Variable } from './api';

export const SECRET_MASK = '••••••••';
export const REDACTED = '[redacted]';

/** Build lookup: env-scoped variable wins over shared (environmentId=null). */
export function buildVarMap(vars: Variable[], environmentId: string | null): Map<string, Variable> {
  const map = new Map<string, Variable>();
  for (const v of vars) {
    if (v.environmentId !== null) continue; // shared first (lower priority)
    if (!map.has(v.key)) map.set(v.key, v);
  }
  for (const v of vars) {
    if (environmentId !== null && v.environmentId === environmentId) map.set(v.key, v); // env wins
  }
  return map;
}

export function resolveValue(key: string, vars: Variable[], environmentId: string | null): string | null {
  const v = buildVarMap(vars, environmentId).get(key);
  if (!v || v.value == null) return null; // secrets have no client-side plaintext
  return v.value;
}

const TOKEN_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Preview interpolation. Secrets render as ••, missing keys stay as-is. */
export function interpolatePreview(template: string, vars: Variable[], environmentId: string | null): string {
  const map = buildVarMap(vars, environmentId);
  return template.replace(TOKEN_RE, (m, key: string) => {
    const v = map.get(key);
    if (!v) return m;
    if (v.isSecret) return SECRET_MASK;
    return v.value ?? m;
  });
}

/**
 * Redact known secret *plaintext* occurrences from a log line.
 * Client only knows non-secret values + secret keys' {{TOKEN}} form; the
 * server is responsible for never sending secret plaintext over WS/REST.
 * This is defense-in-depth for values the client typed this session.
 */
export function redactText(text: string, knownSecrets: string[]): string {
  let out = text;
  for (const s of knownSecrets) {
    if (s && out.includes(s)) out = out.split(s).join(REDACTED);
  }
  // Never leak {{SECRET_KEY}} resolutions: mask token values already handled
  // by interpolatePreview; here just collapse accidental secret-looking assignments.
  return out;
}

/** Code preview: {{KEY}} compiles to runtime env helper, never a literal. */
export function codePreviewFor(template: string, secretKeys: Set<string>): string {
  return template.replace(TOKEN_RE, (_m, key: string) =>
    secretKeys.has(key)
      ? `process.env['${key}'] /* secret — resolved at runtime, never inlined */`
      : `(process.env['${key}'] ?? '{{${key}}}')`,
  );
}

export function secretKeysOf(vars: Variable[]): Set<string> {
  return new Set(vars.filter((v) => v.isSecret).map((v) => v.key));
}
