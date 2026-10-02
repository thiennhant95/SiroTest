import type { FastifyInstance } from 'fastify';
import {
  compileTest,
  InvalidDefinitionError,
  UnsupportedStepError,
  type ReusableAction,
  type TestDefinition,
  type TestStep,
} from '@vietvang/playwright-compiler';
import { requireAuth } from '../auth.js';
import { ApiError } from '../errors.js';
import { db } from '../db.js';
import { actionMap, loadProjectActions } from '../actions.js';
import { sanitizeExportFilename } from '../security.js';

/**
 * Server preview/export compiler (P0).
 *
 * This route MUST NOT fork the step mapping: it delegates to the canonical
 * `packages/playwright-compiler` (`compileTest`). Same definition ⇒ same
 * byte-identical output as every other consumer. Unsupported steps fail
 * explicitly (422 COMPILER_UNSUPPORTED_STEP) — never silently skipped, never
 * `// TODO` placeholders, never `page.locator('body')` fallbacks.
 */
export function compileDefinition(def: {
  steps?: Array<Record<string, unknown>>;
  name?: string;
  datasets?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}, opts?: { datasetId?: string; actions?: ReusableAction[] | Map<string, ReusableAction> }): string {
  const full = normalizeDefinition(def);
  const compileOpts: { datasetId?: string; actions?: Map<string, ReusableAction> } = {};
  if (opts?.datasetId !== undefined) compileOpts.datasetId = opts.datasetId;
  if (opts?.actions !== undefined) {
    compileOpts.actions = opts.actions instanceof Map ? opts.actions : actionMap(opts.actions);
  }
  try {
    return compileTest(full, compileOpts);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      err instanceof UnsupportedStepError ||
      err instanceof InvalidDefinitionError ||
      (err instanceof Error && err.name === 'UnsupportedLocatorError')
    ) {
      throw new ApiError('COMPILER_UNSUPPORTED_STEP', message, 422, {
        step: err instanceof UnsupportedStepError ? { id: err.stepId, type: err.stepType } : undefined,
      });
    }
    throw err;
  }
}

/**
 * Lift the loose `{ steps, name }` preview shape (used by tests and older
 * callers) into a full versioned `TestDefinition`. Stored definitions parsed
 * from `definitionJson` already carry these fields and pass through intact.
 */
function normalizeDefinition(def: {
  steps?: Array<Record<string, unknown>>;
  name?: string;
  [key: string]: unknown;
}): TestDefinition {
  const raw = def as Record<string, unknown>;
  const browser =
    raw['browser'] === 'firefox' || raw['browser'] === 'webkit' || raw['browser'] === 'chromium'
      ? (raw['browser'] as TestDefinition['browser'])
      : 'chromium';
  const normalized: TestDefinition = {
    schemaVersion: '1.0',
    id: typeof raw['id'] === 'string' && raw['id'].length > 0 ? (raw['id'] as string) : 'preview',
    projectId:
      typeof raw['projectId'] === 'string' && raw['projectId'].length > 0
        ? (raw['projectId'] as string)
        : 'preview',
    name: typeof def.name === 'string' && def.name.length > 0 ? def.name : 'recorded test',
    browser,
    steps: ((def.steps ?? []) as TestStep[]).map((s) => ({ ...s }) as TestStep),
  };
  if (typeof raw['description'] === 'string') normalized.description = raw['description'] as string;
  if (typeof raw['baseUrl'] === 'string') normalized.baseUrl = raw['baseUrl'] as string;
  if (typeof raw['timeoutMs'] === 'number') normalized.timeoutMs = raw['timeoutMs'] as number;
  if (raw['viewport'] && typeof raw['viewport'] === 'object') {
    normalized.viewport = raw['viewport'] as TestDefinition['viewport'];
  }
  if (raw['variables'] && typeof raw['variables'] === 'object') {
    normalized.variables = raw['variables'] as Record<string, string>;
  }
  // P1 datasets pass through untouched (canonical compiler validates the
  // selected id at compile time; stored shape was validated at import).
  if (Array.isArray(raw['datasets'])) {
    (normalized as unknown as Record<string, unknown>)['datasets'] = raw['datasets'];
  }
  return normalized;
}

export async function compilerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/tests/:id/compile', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { datasetId?: string };
    const test = await db().test.findUnique({ where: { id } });
    if (!test) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    const def = JSON.parse(test.definitionJson) as { steps?: Array<Record<string, unknown>>; name?: string };
    // P1 actions: resolve the project's callees so `callAction` steps inline.
    const actions = await loadProjectActions(test.projectId);
    const code = compileDefinition(
      def,
      {
        ...(typeof body.datasetId === 'string' ? { datasetId: body.datasetId } : {}),
        ...(actions.length > 0 ? { actions } : {}),
      },
    );
    return { testId: id, code };
  });

  app.get('/tests/:id/export', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { format, datasetId } = req.query as { format?: string; datasetId?: string };
    if (format && format !== 'spec') {
      throw new ApiError('VALIDATION_ERROR', 'Only format=spec is supported in P0', 400);
    }
    const test = await db().test.findUnique({ where: { id } });
    if (!test) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    const def = JSON.parse(test.definitionJson) as { steps?: Array<Record<string, unknown>>; name?: string };
    const actions = await loadProjectActions(test.projectId);
    const code = compileDefinition(
      def,
      {
        ...(typeof datasetId === 'string' && datasetId ? { datasetId } : {}),
        ...(actions.length > 0 ? { actions } : {}),
      },
    );
    return reply
      .header('content-type', 'text/x-typescript')
      .header('content-disposition', `attachment; filename="${sanitizeExportFilename(id)}"`)
      .send(code);
  });
}
