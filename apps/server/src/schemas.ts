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
