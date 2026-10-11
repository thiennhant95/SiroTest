import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { db } from '../db.js';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { requireProjectWrite } from '../rbac.js';
import { ApiError } from '../errors.js';
import { parseOrThrow, junitImport, specImport } from '../schemas.js';
import { validateDefinitionForStore } from '../security.js';
import { parsePlaywrightSpec, SpecParseError } from '../spec-importer.js';
import { JunitParseError, parseJunitXml } from '../junit-import.js';

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

  app.post('/projects/:projectId/import-junit', { preHandler: requireAuth }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    await requireProjectWrite(req);
    const project = await db().project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError('NOT_FOUND', `Project ${projectId} not found`, 404);
    const body = parseOrThrow(junitImport, req.body);
    let doc: ReturnType<typeof parseJunitXml>;
    try {
      doc = parseJunitXml(body.xml);
    } catch (err) {
      if (err instanceof JunitParseError) {
        const noCases = /no <testcase>/.test(err.message);
        throw new ApiError(noCases ? 'JUNIT_NO_CASES' : 'VALIDATION_ERROR', err.message, noCases ? 422 : 400);
      }
      throw err;
    }
    // JUnit has no steps: each case becomes a DRAFT shell (empty steps, like
    // a blank Builder test) with the original outcome in the description.
    // Shells cannot run until steps are recorded — nothing is fabricated.
    const tests: Array<{ id: string; name: string }> = [];
    const warnings: Array<{ case: string; text: string }> = [];
    for (const c of doc.cases) {
      const name = c.name.slice(0, 200);
      const lines = [
        `imported from JUnit${doc.suiteName ?? body.suiteName ? ` (suite: ${doc.suiteName ?? body.suiteName})` : ''}`,
        `original status: ${c.status}`,
        ...(c.timeSeconds !== null ? [`original time: ${c.timeSeconds}s`] : []),
        ...(c.message ? [`original message: ${c.message}`] : []),
        'shell has no steps — record via the recorder before running.',
      ];
      const definition = {
        schemaVersion: '1.0',
        id: `test_${nanoid(10)}`,
        projectId,
        name,
        browser: 'chromium',
        tags: ['junit-import'],
        steps: [],
      };
      const created = await db().test.create({
        data: {
          projectId,
          name,
          description: lines.join('\n'),
          definitionJson: JSON.stringify(definition),
          createdBy: req.user!.id,
        },
      });
      await db().testVersion.create({
        data: {
          testId: created.id,
          versionNumber: 1,
          definitionJson: created.definitionJson,
          createdBy: req.user!.id,
          changeMessage: 'imported from JUnit',
        },
      });
      tests.push({ id: created.id, name });
      warnings.push({
        case: c.name,
        text: c.status === 'passed'
          ? 'shell has no steps — record via the recorder before running'
          : `original ${c.status} in JUnit; imported as an unrunnable shell — record steps, then re-verify`,
      });
    }
    return reply.code(201).send({ tests, warnings });
  });
}
