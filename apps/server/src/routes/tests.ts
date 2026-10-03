import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { db } from '../db.js';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { ApiError } from '../errors.js';
import { parseOrThrow, testCreate, testUpdate } from '../schemas.js';
import { validateDefinitionForStore } from '../security.js';

/** Reject unknown step types (custom code disabled in P0) before persisting. */
function assertStorableDefinition(definitionJson: unknown): void {
  if (definitionJson === undefined) return;
  const issues = validateDefinitionForStore(definitionJson);
  if (issues.length > 0) {
    const unsupported = issues.some((i) => i.code === 'STEP_TYPE_UNSUPPORTED' || i.code === 'STEP_FIELD_FORBIDDEN');
    throw new ApiError(
      unsupported ? 'COMPILER_UNSUPPORTED_STEP' : 'VALIDATION_ERROR',
      `Invalid test definition: ${issues.map((i) => i.message).join('; ')}`,
      unsupported ? 422 : 400,
      { issues },
    );
  }
}

function blankDefinition(projectId: string, name: string, browser = 'chromium'): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    id: `test_${nanoid(10)}`,
    projectId,
    name,
    browser,
    steps: [],
  };
}

export async function testRoutes(app: FastifyInstance): Promise<void> {
  // list under project; ?tag=X filters by TestDefinition.tags (P1, additive).
  app.get('/projects/:projectId/tests', { preHandler: requireAuth }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const { tag } = req.query as { tag?: string };
    const rows = await db().test.findMany({ where: { projectId }, orderBy: { updatedAt: 'desc' } });
    if (!tag) return rows;
    return rows.filter((t) => {
      try {
        const def = JSON.parse(t.definitionJson) as { tags?: unknown };
        return Array.isArray(def.tags) && def.tags.includes(tag);
      } catch {
        return false;
      }
    });
  });

  app.post('/projects/:projectId/tests', { preHandler: requireAuth }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    await requireProjectAccess(req);
    const body = parseOrThrow(testCreate, req.body);
    assertStorableDefinition(body.definitionJson);
    const created = await db().test.create({
      data: {
        projectId,
        name: body.name,
        description: body.description,
        definitionJson: JSON.stringify(body.definitionJson ?? blankDefinition(projectId, body.name, body.browser)),
        createdBy: req.user!.id,
      },
    });
    await db().testVersion.create({
      data: {
        testId: created.id, versionNumber: 1,
        definitionJson: created.definitionJson,
        createdBy: req.user!.id, changeMessage: 'initial version',
      },
    });
    return reply.code(201).send({ ...created, definitionJson: JSON.parse(created.definitionJson) });
  });

  app.get('/tests/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    await requireProjectAccess(req);
    const t = await db().test.findUnique({ where: { id } });
    if (!t) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    return t;
  });

  // meaningful save -> new immutable version (versioning.md)
  app.patch('/tests/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parseOrThrow(testUpdate, req.body);
    assertStorableDefinition(body.definitionJson);
    const existing = await db().test.findUnique({ where: { id }, include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } } });
    if (!existing) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    const updated = await db().test.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.definitionJson ? { definitionJson: JSON.stringify(body.definitionJson) } : {}),
      },
    });
    if (body.definitionJson) {
      const next = (existing.versions[0]?.versionNumber ?? 0) + 1;
      await db().testVersion.create({
        data: {
          testId: id, versionNumber: next,
          definitionJson: updated.definitionJson,
          createdBy: req.user!.id, changeMessage: body.changeMessage ?? null,
        },
      });
    }
    return updated;
  });

  app.delete('/tests/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await db().test.delete({ where: { id } });
    } catch {
      throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    }
    return reply.code(204).send();
  });

  app.post('/tests/:id/duplicate', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const src = await db().test.findUnique({ where: { id } });
    if (!src) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    const copy = await db().test.create({
      data: {
        projectId: src.projectId, name: `${src.name} (copy)`,
        description: src.description, definitionJson: src.definitionJson,
        createdBy: req.user!.id,
      },
    });
    await db().testVersion.create({
      data: {
        testId: copy.id, versionNumber: 1, definitionJson: copy.definitionJson,
        createdBy: req.user!.id, changeMessage: `duplicated from ${id}`,
      },
    });
    return reply.code(201).send(copy);
  });

  app.get('/tests/:id/versions', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return db().testVersion.findMany({ where: { testId: id }, orderBy: { versionNumber: 'desc' } });
  });

  // restore creates a NEW version; history is never deleted
  app.post('/tests/:id/versions/:versionId/restore', { preHandler: requireAuth }, async (req) => {
    const { id, versionId } = req.params as { id: string; versionId: string };
    const v = await db().testVersion.findUnique({ where: { id: versionId } });
    if (!v || v.testId !== id) throw new ApiError('NOT_FOUND', `Version ${versionId} not found`, 404);
    const latest = await db().testVersion.findMany({
      where: { testId: id }, orderBy: { versionNumber: 'desc' }, take: 1,
    });
    const next = (latest[0]?.versionNumber ?? 0) + 1;
    await db().test.update({ where: { id }, data: { definitionJson: v.definitionJson } });
    return db().testVersion.create({
      data: {
        testId: id, versionNumber: next, definitionJson: v.definitionJson,
        createdBy: req.user!.id, changeMessage: `restore v${v.versionNumber}`,
      },
    });
  });
}
