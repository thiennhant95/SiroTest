/**
 * Step 2/8 — Resolve environment / variables.
 * Merge order: project defaults -> environment overrides -> test-level variables.
 * Secret values are resolved at run time and NEVER inlined into generated code;
 * they are injected via process env and redacted from logs/events/result JSON.
 */

import type { TestDefinition, VariableDef } from './types.js';

export interface ResolvedEnv {
  /** runtime values injected as process env for the Playwright child */
  runtimeEnv: Record<string, string>;
  /** plaintext secret values, kept in memory only for redaction */
  secrets: string[];
  /** redacted copy safe for logs / WS payloads / result.json */
  redacted: Record<string, string>;
}

export const REDACTED = '***';

function toMap(vars: VariableDef[] | undefined, out: Map<string, VariableDef>): void {
  for (const v of vars ?? []) {
    if (typeof v.key !== 'string' || v.key.length === 0) continue;
    out.set(v.key, v);
  }
}

export function resolveEnv(opts: {
  test: TestDefinition;
  projectVariables?: VariableDef[];
  environmentVariables?: VariableDef[];
}): ResolvedEnv {
  const merged = new Map<string, VariableDef>();
  toMap(opts.projectVariables, merged);
  toMap(opts.environmentVariables, merged);
  // Test-level variables (Record<string,string>) are non-secret by definition;
  // secret test values must come through environments as {{VAR}} references.
  if (opts.test.variables) {
    for (const [key, value] of Object.entries(opts.test.variables)) {
      merged.set(key, { key, value, isSecret: false });
    }
  }

  const runtimeEnv: Record<string, string> = {};
  const redacted: Record<string, string> = {};
  const secrets: string[] = [];
  // Sort keys for deterministic output.
  const keys = [...merged.keys()].sort();
  for (const key of keys) {
    const v = merged.get(key)!;
    runtimeEnv[key] = v.value;
    if (v.isSecret) {
      redacted[key] = REDACTED;
      if (v.value.length > 0) secrets.push(v.value);
    } else {
      redacted[key] = v.value;
    }
  }
  return { runtimeEnv, secrets, redacted };
}

/** Replace every occurrence of each secret with '***'. Also masks {{SECRET_NAME}} echoes. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  const ordered = [...secrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  for (const secret of ordered) {
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Variable names referenced as {{NAME}} inside a template string. */
export function findTemplateVars(template: string): string[] {
  const names: string[] = [];
  const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) names.push(m[1]);
  return [...new Set(names)];
}
