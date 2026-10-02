/**
 * P1 dataset import parsing (CSV/JSON → embedded dataset rows).
 *
 * - CSV: minimal RFC-4180 parser written by hand (no new dependency):
 *   comma-separated fields, `"quoted"` fields, `""` escapes, CRLF/LF, and
 *   embedded newlines inside quoted fields. First row = headers.
 * - JSON: top-level array of flat objects; number/boolean/null cells are
 *   coerced explicitly (numbers/booleans → String(v), null → ''), nested
 *   objects/arrays are rejected (rows must stay flat string maps).
 * - Column names must match /^[A-Za-z_][A-Za-z0-9_]*$/ so every header is a
 *   valid `{{row.NAME}}` reference that compiles safely. Violations fail
 *   explicitly (never silently renamed).
 * - Rows are PLAINTEXT by design: never import secrets via datasets — use
 *   `{{VARIABLES}}` instead (see DATASET_SECRET_NOTE in the compiler).
 */

export class DatasetParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatasetParseError';
  }
}

export const DATASET_COLUMN_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Max columns per imported table (artifact/size discipline). */
export const MAX_DATASET_COLUMNS = 50;

/** Max characters per imported cell. */
export const MAX_DATASET_CELL_CHARS = 8000;

/** Max raw import payload (bytes) accepted before parsing. */
export const MAX_DATASET_IMPORT_BYTES = 512 * 1024;

/**
 * Parse RFC-4180 CSV text into a matrix of fields (no trimming of values —
 * what the user typed is what the row holds; headers are trimmed).
 */
export function parseCsvMatrix(content: string): string[][] {
  const text = content.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldQuoted = false;
  let i = 0;

  const pushField = (): void => {
    row.push(fieldQuoted ? field : field);
    field = '';
    fieldQuoted = false;
  };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += c;
        i += 1;
      }
      continue;
    }
    if (c === '"') {
      // A quote is only special at field start; mid-field quotes are literal
      // (strict parsers reject them — we keep the byte to avoid data loss,
      // and the value stays visible in the preview table).
      if (field.length === 0) {
        inQuotes = true;
        fieldQuoted = true;
        i += 1;
      } else {
        field += c;
        i += 1;
      }
      continue;
    }
    if (c === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (c === '\r' && text[i + 1] === '\n') {
      pushField();
      rows.push(row);
      row = [];
      i += 2;
      continue;
    }
    if (c === '\n' || c === '\r') {
      pushField();
      rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (inQuotes) {
    throw new DatasetParseError('CSV has an unterminated quoted field (missing closing ")');
  }
  // Trailing content without a final newline still forms a row.
  if (field.length > 0 || fieldQuoted || row.length > 0) {
    pushField();
    rows.push(row);
  }
  // Drop wholly-empty lines (e.g. trailing newline artifacts), but keep
  // rows that carry at least one non-empty field.
  return rows.filter((r) => r.some((f) => f !== ''));
}

function checkCell(value: string, column: string): void {
  if (value.length > MAX_DATASET_CELL_CHARS) {
    throw new DatasetParseError(
      `column '${column}' has a cell of ${value.length} chars (max ${MAX_DATASET_CELL_CHARS})`,
    );
  }
}

function validateHeaders(headers: string[]): string[] {
  const trimmed = headers.map((h) => h.trim());
  if (trimmed.some((h) => h.length === 0)) {
    throw new DatasetParseError('CSV header row contains an empty column name');
  }
  if (trimmed.length > MAX_DATASET_COLUMNS) {
    throw new DatasetParseError(
      `CSV has ${trimmed.length} columns (max ${MAX_DATASET_COLUMNS})`,
    );
  }
  const bad = trimmed.filter((h) => !DATASET_COLUMN_PATTERN.test(h));
  if (bad.length > 0) {
    throw new DatasetParseError(
      `invalid column name(s) ${bad.map((b) => `'${b}'`).join(', ')} — columns must match /^[A-Za-z_][A-Za-z0-9_]*$/ so {{row.NAME}} compiles safely`,
    );
  }
  if (new Set(trimmed).size !== trimmed.length) {
    throw new DatasetParseError('CSV header row contains duplicate column names');
  }
  return trimmed;
}

/** CSV text → flat string rows (short rows padded with '', extras ignored). */
export function parseCsvDataset(content: string): Record<string, string>[] {
  const matrix = parseCsvMatrix(content);
  if (matrix.length === 0) {
    throw new DatasetParseError('CSV is empty — the first row must be a header row');
  }
  const headers = validateHeaders(matrix[0]);
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < matrix.length; r++) {
    const record: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const value = matrix[r][c] ?? '';
      checkCell(value, headers[c]);
      record[headers[c]] = value;
    }
    rows.push(record);
  }
  return rows;
}

/** JSON text (array of flat objects) → flat string rows. */
export function parseJsonDataset(content: string): Record<string, string>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new DatasetParseError('JSON import must be an array of objects');
  }
  if (!Array.isArray(parsed)) {
    throw new DatasetParseError('JSON import must be a top-level array of row objects');
  }
  if (parsed.length === 0) {
    throw new DatasetParseError('JSON array is empty — at least one row object is required');
  }
  const headers = validateHeaders(
    (() => {
      const keys: string[] = [];
      for (const row of parsed) {
        if (typeof row !== 'object' || row === null || Array.isArray(row)) {
          throw new DatasetParseError('JSON array must contain only row objects');
        }
        for (const k of Object.keys(row)) if (!keys.includes(k)) keys.push(k);
      }
      return keys;
    })(),
  );
  return parsed.map((row, i) => {
    const rec = row as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const h of headers) {
      const v = rec[h];
      if (v === undefined || v === null) {
        out[h] = '';
      } else if (typeof v === 'string') {
        checkCell(v, h);
        out[h] = v;
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        const s = String(v);
        checkCell(s, h);
        out[h] = s;
      } else {
        throw new DatasetParseError(
          `JSON row ${i} column '${h}' must be a string/number/boolean/null (nested objects are not rows)`,
        );
      }
    }
    return out;
  });
}

/** Dispatch CSV/JSON import content → rows (size-capped before parsing). */
export function parseDatasetImport(
  format: 'csv' | 'json',
  content: string,
): Record<string, string>[] {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_DATASET_IMPORT_BYTES) {
    throw new DatasetParseError(
      `import payload is ${bytes} bytes (max ${MAX_DATASET_IMPORT_BYTES})`,
    );
  }
  return format === 'csv' ? parseCsvDataset(content) : parseJsonDataset(content);
}
