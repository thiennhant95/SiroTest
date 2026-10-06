import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { requireProjectWrite } from '../rbac.js';
import { ApiError } from '../errors.js';
import { parseOrThrow, specImport } from '../schemas.js';
import { validateDefinitionForStore } from '../security.js';
import { parsePlaywrightSpec, SpecParseError } from '../spec-importer.js';

/**
 * P1 wave-2 — Playwright spec importer.
 *
 * POST /projects/:projectId/import-spec { code, name? } → parses the
 * feasible TypeScript SUBSET (see spec-importer.ts for the exact list) into
 * a TestDefinition and stores it as a DRAFT test (plus initial version 1,
 * same as POST /tests). Response: { test, warnings[] }.
 *
 * - Unmappable lines are returned in `warnings[]` (line numbers included) —
 *   never silently skipped.
 * - Code with zero mappable steps fails with SPEC_NO_STEPS (422).
 * - Generated definitions pass the same store validation as hand-built ones
 *   (fail explicit, never persisted half-formed).
 */
export async function specImportRoutes(app: FastifyInstance): Promise<void> {
  app.post('/projects/:projectId/import-spec', { preHandler: requireAuth }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    await requireProjectWrite(req);
    const project = await db().project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError('NOT_FOUND', `Project ${projectId} not found`, 404);
    const body = parseOrThrow(specImport, req.body);
    let draft: ReturnType<typeof parsePlaywrightSpec>;
    try {
      draft = parsePlaywrightSpec(body.code, { projectId, ...(body.name ? { name: body.name } : {}) });
    } catch (err) {
      if (err instanceof SpecParseError) {
        throw new ApiError('SPEC_NO_STEPS', err.message, 422);
      }
      throw err;
    }
    const issues = validateDefinitionForStore(draft.definition);
    if (issues.length > 0) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `Imported definition is invalid: ${issues.map((i) => i.message).join('; ')}`,
        400,
      );
    }
    const definitionJson = JSON.stringify(draft.definition);
    const created = await db().test.create({
      data: {
        projectId,
        name: draft.name,
        description: `imported from Playwright spec (${draft.steps.length} steps, ${draft.warnings.length} warnings)`,
        definitionJson,
        createdBy: req.user!.id,
      },
    });
    await db().testVersion.create({
      data: {
        testId: created.id,
        versionNumber: 1,
        definitionJson,
        createdBy: req.user!.id,
        changeMessage: 'imported from spec',
      },
    });
    return reply.code(201).send({
      test: { ...created, definitionJson: draft.definition },
      warnings: draft.warnings,
    });
  });
}
