import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { requireGlobalWriter, requireProjectWrite, requireRole } from '../rbac.js';
import { ApiError } from '../errors.js';
import { parseOrThrow, projectCreate, projectUpdate } from '../schemas.js';

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects', { preHandler: requireAuth }, async (req) => {
    await requireProjectAccess(req);
    return db().project.findMany({ orderBy: { updatedAt: 'desc' } });
  });

  app.post('/projects', { preHandler: requireAuth }, async (req, reply) => {
    await requireGlobalWriter(req);
    const body = parseOrThrow(projectCreate, req.body);
    const created = await db().project.create({ data: body });
    // The creator becomes project owner so subsequent project-scoped writes
    // pass requireProjectAccess. Skipped only when the user row does not exist
    // (dev stub auth mints ids without rows — membership is best-effort there).
    const userRow = await db().user.findUnique({ where: { id: req.user!.id } });
    if (userRow) {
      await db().projectMember.upsert({
        where: { projectId_userId: { projectId: created.id, userId: userRow.id } },
        update: { role: 'owner' },
        create: { projectId: created.id, userId: userRow.id, role: 'owner' },
      });
    }
    return reply.code(201).send(created);
  });

  app.get('/projects/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    await requireProjectAccess(req);
    const found = await db().project.findUnique({ where: { id } });
    if (!found) throw new ApiError('NOT_FOUND', `Project ${id} not found`, 404);
    return found;
  });

  app.patch('/projects/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    await requireProjectWrite(req);
    const body = parseOrThrow(projectUpdate, req.body);
    try {
      return await db().project.update({ where: { id }, data: body });
    } catch {
      throw new ApiError('NOT_FOUND', `Project ${id} not found`, 404);
    }
  });

  app.delete('/projects/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await requireRole(req, id, 'owner');
    // Project delete cascades everything — refuse under live workers.
    const active = await db().run.findFirst({
      where: { projectId: id, status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    if (active) {
      throw new ApiError('CONFLICT_ACTIVE_RUNS', `Project ${id} has active (queued/running) runs — cancel them first`, 409);
    }
    try {
      await db().project.delete({ where: { id } });
    } catch {
      throw new ApiError('NOT_FOUND', `Project ${id} not found`, 404);
    }
    return reply.code(204).send();
  });
}
