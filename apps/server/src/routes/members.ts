/**
 * Project member management (P1.5): list / add / change role / remove.
 *
 * Until this shipped, membership was granted by a direct-DB script, so a
 * freshly signed-up teammate saw no projects. Owners can now manage members
 * from Settings → Members; every change is audited.
 *
 * Rules (deliberate):
 * - Reads require project access (`viewer`+); writes require `owner`.
 * - `owner` is never granted through this API — it comes from project
 *   creation. This keeps a single, auditable owner bootstrap path.
 * - The last owner cannot be demoted or removed (a project with no owner
 *   would be unmanageable).
 * - Adding an email that has not signed up returns 404 with a clear message
 *   (we never create users from an email string).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { requireRole } from '../rbac.js';
import { db } from '../db.js';
import { ApiError } from '../errors.js';
import { parseOrThrow } from '../schemas.js';
import { writeAudit } from './audit.js';

const memberBody = z
  .object({
    email: z.string().email().max(200),
    role: z.enum(['viewer', 'editor']),
  })
  .strict();

const roleBody = z.object({ role: z.enum(['viewer', 'editor']) }).strict();

interface MemberRow {
  userId: string;
  email: string;
  name: string | null;
  role: string;
}

async function listMembers(projectId: string): Promise<MemberRow[]> {
  const rows = await db().projectMember.findMany({
    where: { projectId },
    orderBy: [{ role: 'asc' }],
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  const rank: Record<string, number> = { owner: 0, editor: 1, viewer: 2 };
  return rows
    .map((r) => ({
      userId: r.user.id,
      email: r.user.email,
      name: r.user.name,
      role: r.role,
    }))
    .sort((a, b) => (rank[a.role] ?? 9) - (rank[b.role] ?? 9) || a.email.localeCompare(b.email));
}

async function ownerCount(projectId: string): Promise<number> {
  return db().projectMember.count({ where: { projectId, role: 'owner' } });
}

export async function memberRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects/:projectId/members', { preHandler: requireAuth }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    await requireRole(req, projectId, 'viewer');
    return listMembers(projectId);
  });

  app.post('/projects/:projectId/members', { preHandler: requireAuth }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    await requireRole(req, projectId, 'owner');
    const body = parseOrThrow(memberBody, req.body);
    const email = body.email.trim().toLowerCase();

    const project = await db().project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
    if (!project) throw new ApiError('NOT_FOUND', `Project ${projectId} not found`, 404);

    const user = await db().user.findFirst({ where: { email } });
    if (!user) {
      throw new ApiError(
        'NOT_FOUND',
        `No account for ${email}. Ask them to sign up first, then add the email here.`,
        404,
      );
    }

    const existing = await db().projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: user.id } },
    });
    if (existing) {
      throw new ApiError('VALIDATION_ERROR', `${email} is already a member of this project`, 409);
    }

    const created = await db().projectMember.create({
      data: { projectId, userId: user.id, role: body.role },
    });
    await writeAudit({
      projectId,
      userId: req.user!.id,
      action: 'project.member_add',
      entityType: 'user',
      entityId: user.id,
      details: { email, role: body.role },
    });
    return reply.code(201).send({ userId: user.id, email, name: user.name, role: created.role });
  });

  app.patch('/projects/:projectId/members/:userId', { preHandler: requireAuth }, async (req) => {
    const { projectId, userId } = req.params as { projectId: string; userId: string };
    await requireRole(req, projectId, 'owner');
    const body = parseOrThrow(roleBody, req.body);

    const member = await db().projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      include: { user: { select: { email: true } } },
    });
    if (!member) throw new ApiError('NOT_FOUND', `User ${userId} is not a member of this project`, 404);
    if (member.role === 'owner') {
      throw new ApiError('VALIDATION_ERROR', 'The project owner role cannot be changed here', 400);
    }
    if (member.role === body.role) return { userId, email: member.user.email, role: member.role };

    const updated = await db().projectMember.update({
      where: { projectId_userId: { projectId, userId } },
      data: { role: body.role },
    });
    await writeAudit({
      projectId,
      userId: req.user!.id,
      action: 'project.member_role',
      entityType: 'user',
      entityId: userId,
      details: { email: member.user.email, from: member.role, to: body.role },
    });
    return { userId, email: member.user.email, role: updated.role };
  });

  app.delete('/projects/:projectId/members/:userId', { preHandler: requireAuth }, async (req, reply) => {
    const { projectId, userId } = req.params as { projectId: string; userId: string };
    await requireRole(req, projectId, 'owner');

    const member = await db().projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      include: { user: { select: { email: true } } },
    });
    if (!member) throw new ApiError('NOT_FOUND', `User ${userId} is not a member of this project`, 404);
    if (member.role === 'owner') {
      if ((await ownerCount(projectId)) <= 1) {
        throw new ApiError('VALIDATION_ERROR', 'Cannot remove the last owner of a project', 400);
      }
    }

    await db().projectMember.delete({ where: { projectId_userId: { projectId, userId } } });
    await writeAudit({
      projectId,
      userId: req.user!.id,
      action: 'project.member_remove',
      entityType: 'user',
      entityId: userId,
      details: { email: member.user.email, role: member.role },
    });
    return reply.code(204).send();
  });
}
