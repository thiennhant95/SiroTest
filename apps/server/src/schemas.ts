import { z } from 'zod';
import { ApiError } from './errors.js';

export const idParam = z.object({ id: z.string().min(1) });
export const projectIdParam = z.object({ projectId: z.string().min(1) });
export const testIdParam = z.object({ id: z.string().min(1) });
export const sessionIdParam = z.object({ sessionId: z.string().min(1) });
export const runIdParam = z.object({ id: z.string().min(1) });

export const projectCreate = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  baseUrl: z.string().url().optional(),
});
export const projectUpdate = projectCreate.partial();

export const testCreate = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  definitionJson: z.record(z.unknown()).optional(), // validated deeper by test-model in P0+
  browser: z.enum(['chromium', 'firefox', 'webkit']).optional(),
});
export const testUpdate = testCreate.partial().extend({
  changeMessage: z.string().max(500).optional(),
});

export const envCreate = z.object({
  name: z.string().min(1).max(120),
  baseUrl: z.string().url().optional(),
  isDefault: z.boolean().optional(),
});
export const envUpdate = envCreate.partial();

export const recorderStart = z.object({
  baseUrl: z.string().url().optional(),
  includeHover: z.boolean().optional(),
});
export const locatorTest = z.object({
  candidate: z.record(z.unknown()), // LocatorCandidate per test-definition.md
});
export const assertionAdd = z.object({
  type: z.enum(['assertVisible', 'assertHidden', 'assertText', 'assertContainsText', 'assertValue', 'assertURL', 'assertTitle', 'assertEnabled', 'assertDisabled', 'assertChecked']),
  target: z.record(z.unknown()).optional(),
  expected: z.string().max(5000).optional(),
});

export const runCreate = z.object({
  environmentId: z.string().min(1),
  browser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  headed: z.boolean().default(false),
  /** P1 data-driven: dataset id embedded in the test definition. */
  datasetId: z.string().min(1).optional(),
  /** P1 data-driven: single 0-based row (requires datasetId). */
  rowIndex: z.number().int().nonnegative().optional(),
});

/** P1 dataset import (CSV/JSON text → embedded definition.datasets). */
export const datasetImport = z.object({
  format: z.enum(['csv', 'json']),
  name: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(512 * 1024),
});

// P1 — suites/tags + suite parallelism/retries.
export const suiteCreate = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});
export const suiteUpdate = suiteCreate.partial();

export const suiteMemberAdd = z.object({
  testId: z.string().min(1),
  sortOrder: z.number().int().optional(),
});
export const suiteMembersReplace = z.object({
  // Full ordered membership; replaces existing rows (reorder = PUT ordered ids).
  testIds: z.array(z.string().min(1)).max(200),
});

export const suiteRunCreate = z.object({
  environmentId: z.string().min(1),
  browser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  headed: z.boolean().default(false),
  // Max automatic retries per failing test (new attempt Run rows, default 0).
  retries: z.number().int().min(0).max(5).default(0),
  // Desired parallelism, clamped to the server queue capacity (RunQueue(2)).
  // 2 = enqueue all at once (queue caps concurrency); 1 = strict sequential.
  parallel: z.number().int().min(1).max(2).default(2),
});

// P1 — reusable actions (mirrors test-model reusableActionSchema; the
// canonical validation lives in packages/test-model, this is the REST
// boundary shape). Body steps are validated deeper in routes/actions.ts
// (P0-only: nested callAction rejected).
const actionParameterName = z.string().min(1).max(120).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'parameter name must match /^[A-Za-z_][A-Za-z0-9_]*$/');
export const actionParameter = z.object({
  name: actionParameterName,
  description: z.string().max(500).optional(),
  default: z.string().max(5000).optional(),
  secret: z.boolean().optional(),
});
export const actionCreate = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  parameters: z.array(actionParameter).max(50).optional(),
  steps: z.array(z.record(z.unknown())).min(1),
});
export const actionUpdate = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  parameters: z.array(actionParameter).max(50).optional(),
  steps: z.array(z.record(z.unknown())).min(1).optional(),
});

const variableKey = z.string().min(1).max(120).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'KEY must match /^[A-Za-z_][A-Za-z0-9_]*$/');
export const variableCreate = z.object({
  environmentId: z.string().min(1).nullable().optional(),
  key: variableKey,
  value: z.string().max(8000),
  isSecret: z.boolean().optional(),
});
export const variableUpdate = z.object({
  key: variableKey.optional(),
  value: z.string().max(8000).optional(),
  isSecret: z.boolean().optional(),
});

export function parseOrThrow<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ApiError('VALIDATION_ERROR', 'Invalid request payload', 400, r.error.flatten());
  }
  return r.data;
}
