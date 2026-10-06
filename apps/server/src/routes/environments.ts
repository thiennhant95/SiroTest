import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { assertNoActiveRuns, requireProjectWrite, requireWriteAccessToProject } from '../rbac.js';
import { ApiError } from '../errors.js';
import { parseOrThrow, envCreate, envUpdate } from '../schemas.js';

export async function environmentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects/:projectId/environments', { preHandler: requireAuth }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    await requireProjectAccess(req);
    return db().environment.findMany({ where: { projectId }, orderBy: { name: 'asc' } });
  });

  app.post('/projects/:projectId/environments', { preHandler: requireAuth }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    await requireProjectWrite(req);
    const body = parseOrThrow(envCreate, req.body);
    if (body.isDefault) {
      await db().environment.updateMany({ where: { projectId }, data: { isDefault: false } });
    }
    const created = await db().environment.create({ data: { projectId, ...body } });
    return reply.code(201).send(created);
  });

  app.patch('/environments/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parseOrThrow(envUpdate, req.body);
    const existing = await db().environment.findUnique({ where: { id }, select: { projectId: true } });
    if (!existing) throw new ApiError('NOT_FOUND', `Environment ${id} not found`, 404);
    await requireWriteAccessToProject(req, existing.projectId);
    try {
      return await db().environment.update({ where: { id }, data: body });
    } catch {
      throw new ApiError('NOT_FOUND', `Environment ${id} not found`, 404);
    }
  });

  app.delete('/environments/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await db().environment.findUnique({ where: { id }, select: { projectId: true } });
    if (!existing) throw new ApiError('NOT_FOUND', `Environment ${id} not found`, 404);
    await requireWriteAccessToProject(req, existing.projectId);
    await assertNoActiveRuns({ environmentId: id }, `Environment ${id}`);
    try {
      await db().environment.delete({ where: { id } });
    } catch {
      throw new ApiError('NOT_FOUND', `Environment ${id} not found`, 404);
    }
    return reply.code(204).send();
  });
}
