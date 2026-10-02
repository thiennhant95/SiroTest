/**
 * result.json schema (07-runner/artifacts-reporting.md).
 * Written by the custom reporter to storage/runs/<run-id>/result.json.
 * All secret values are redacted BEFORE writing — never persist plaintext
 * secrets in result JSON, filenames or metadata.
 */

export type RunResultStatus = 'passed' | 'failed' | 'cancelled';
export type StepResultStatus = 'passed' | 'failed' | 'skipped';

export interface StepResultEntry {
  stepId: string;
  name?: string;
  status: StepResultStatus;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  error?: string;
  /** artifact-relative path, e.g. runs/<run-id>/screenshots/s3.png */
  screenshot?: string;
  timeoutMs?: number;
  timeoutSource?: 'step' | 'test' | 'project' | 'default';
}

export interface RunResultJson {
  schemaVersion: '1.0';
  runId: string;
  status: RunResultStatus;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  error?: string;
  steps: StepResultEntry[];
  artifacts: {
    trace?: string;
    video?: string;
    screenshots: string[];
  };
  compilerVersion?: string;
}

export const REDACTED = '***';

/** Redact every secret occurrence in free-text fields of a result object. */
export function redactResult<T>(value: T, secrets: string[]): T {
  if (secrets.length === 0) return value;
  const ordered = [...secrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  const redactText = (text: string): string => {
    let out = text;
    for (const s of ordered) out = out.split(s).join(REDACTED);
    return out;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return redactText(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  return walk(value) as T;
}
