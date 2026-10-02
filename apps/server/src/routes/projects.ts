import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { ApiError } from '../errors.js';
import { parseOrThrow, projectCreate, projectUpdate } from '../schemas.js';

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects', { preHandler: requireAuth }, async (req) => {
    await requireProjectAccess(req);
    return db().project.findMany({ orderBy: { updatedAt: 'desc' } });
  });

  app.post('/projects', { preHandler: requireAuth }, async (req, reply) => {
    const body = parseOrThrow(projectCreate, req.body);
    const created = await db().project.create({ data: body });
    return reply.code(201).send(created);
  });

  app.get('/projects/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const found = await db().project.findUnique({ where: { id } });
    if (!found) throw new ApiError('NOT_FOUND', `Project ${id} not found`, 404);
    return found;
  });

  app.patch('/projects/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parseOrThrow(projectUpdate, req.body);
    try {
      return await db().project.update({ where: { id }, data: body });
    } catch {
      throw new ApiError('NOT_FOUND', `Project ${id} not found`, 404);
    }
  });

  app.delete('/projects/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await db().project.delete({ where: { id } });
    } catch {
      throw new ApiError('NOT_FOUND', `Project ${id} not found`, 404);
    }
    return reply.code(204).send();
  });
}
