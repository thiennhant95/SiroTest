/** Shared P0 helpers (result type, ids, variable interpolation). */

export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Generate a lexicographically sortable-ish id without external deps. */
export function newId(prefix = "id"): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/**
 * Interpolate `{{VAR}}` placeholders (see examples/login-test.json).
 * Unknown keys are left untouched so the caller can warn, not silently drop.
 */
export function interpolateVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m,
  );
}
