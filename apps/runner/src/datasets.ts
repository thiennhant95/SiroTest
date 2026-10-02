/**
 * P1 data-driven runs: dataset row resolution for the runner lifecycle.
 *
 * Design decisions (documented here + covered by tests):
 * - Rows are PLAIN strings embedded in the test definition. Secrets MUST use
 *   `{{VARIABLES}}` (resolved at run time, redacted everywhere) — NEVER
 *   dataset rows. The compiler carries the same note in generated code.
 * - `datasetId` selects a table from `test.datasets`; `rowIndex` (optional)
 *   narrows the run to a single 0-based row. Unknown ids / out-of-range
 *   indexes fail fast with ValidationError (never silently full-table).
 * - Selected rows are injected as `VV_DATASET_ROWS` (JSON) into the Playwright
 *   child env. Payloads over VV_DATASET_ROWS_MAX_BYTES fail fast instead of
 *   truncating (no silent data loss).
 * - Iteration aggregation (reporter + run.ts persist): every loop iteration
 *   reports under the SAME step ids, so per-step records merge as
 *   `durationMs = sum(iterations)`, `status = failed if ANY iteration failed`
 *   (first error kept). Rationale: step identity is definition-scoped; the
 *   dataset only multiplies executions. Alternatives (per-iteration step rows)
 *   were rejected — they would break WS step.* contracts and run-detail UIs
 *   that join on stepId.
 */

import { ValidationError } from './validate.js';
import type { DataSet, TestDefinition } from './types.js';

/**
 * Re-exported so consumers can `instanceof`-check dataset failures with the
 * exact class this module throws (robust against dual ESM/CJS loader
 * instances of validate.js under tsx, e.g. tests importing runner `src`).
 */
export { ValidationError };

/** Child-env key carrying the selected dataset rows (JSON). */
export const VV_DATASET_ROWS_ENV = 'VV_DATASET_ROWS';

/** Max JSON bytes injected via VV_DATASET_ROWS (fail fast above this). */
export const VV_DATASET_ROWS_MAX_BYTES = Number(
  process.env.VV_DATASET_ROWS_MAX_BYTES ?? 256 * 1024,
);

/** Maximum rows per embedded dataset (mirrors test-model zod cap). */
export const MAX_DATASET_ROWS = 500;

function isDataset(v: unknown): v is DataSet {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d['id'] === 'string' &&
    typeof d['name'] === 'string' &&
    Array.isArray(d['rows'])
  );
}

/**
 * Resolve the rows to execute: all rows of the selected dataset, or the
 * single row at `rowIndex`. No `datasetId` → `[]` (plain P0 run, nothing
 * injected). Throws ValidationError on unknown id / bad index / bad shape.
 */
export function resolveDatasetRows(
  test: TestDefinition,
  datasetId?: string,
  rowIndex?: number,
): Record<string, string>[] {
  if (datasetId === undefined) {
    if (rowIndex !== undefined) {
      throw new ValidationError([
        { code: 'DATASET_ROW_WITHOUT_DATASET', message: 'rowIndex requires datasetId' },
      ]);
    }
    return [];
  }
  const datasets = Array.isArray(test.datasets) ? test.datasets : [];
  const found = datasets.find((d) => isDataset(d) && d.id === datasetId);
  if (!found) {
    throw new ValidationError([
      {
        code: 'DATASET_NOT_FOUND',
        message: `datasetId '${datasetId}' does not exist in this test definition (${datasets.length} dataset(s))`,
      },
    ]);
  }
  validateDatasetShape(found);
  if (rowIndex === undefined) return found.rows;
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= found.rows.length) {
    throw new ValidationError([
      {
        code: 'DATASET_ROW_OUT_OF_RANGE',
        message: `rowIndex ${String(rowIndex)} out of range for dataset '${datasetId}' (${found.rows.length} row(s))`,
      },
    ]);
  }
  return [found.rows[rowIndex]];
}

/** Reject malformed embedded datasets explicitly (cap + string-only cells). */
export function validateDatasetShape(ds: DataSet): void {
  if (ds.rows.length > MAX_DATASET_ROWS) {
    throw new ValidationError([
      {
        code: 'DATASET_TOO_MANY_ROWS',
        message: `dataset '${ds.id}' has ${ds.rows.length} rows (max ${MAX_DATASET_ROWS})`,
      },
    ]);
  }
  ds.rows.forEach((row, i) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new ValidationError([
        { code: 'DATASET_ROW_INVALID', message: `dataset '${ds.id}' row ${i} must be an object` },
      ]);
    }
    for (const [k, v] of Object.entries(row)) {
      if (typeof v !== 'string') {
        throw new ValidationError([
          {
            code: 'DATASET_CELL_INVALID',
            message: `dataset '${ds.id}' row ${i} column '${k}' must be a string (rows are plaintext; secrets belong in {{VARIABLES}})`,
          },
        ]);
      }
    }
  });
}

/**
 * Serialize selected rows for the VV_DATASET_ROWS child env. Fails fast when
 * the JSON payload exceeds VV_DATASET_ROWS_MAX_BYTES (no silent truncation).
 */
export function buildDatasetEnvValue(rows: Record<string, string>[]): string {
  const json = JSON.stringify(rows);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > VV_DATASET_ROWS_MAX_BYTES) {
    throw new ValidationError([
      {
        code: 'DATASET_TOO_LARGE',
        message: `selected dataset rows are ${bytes} bytes (max ${VV_DATASET_ROWS_MAX_BYTES}) — split the dataset or select a single rowIndex`,
      },
    ]);
  }
  return json;
}
