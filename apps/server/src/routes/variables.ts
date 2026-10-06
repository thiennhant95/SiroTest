import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { requireProjectWrite, requireWriteAccessToProject } from '../rbac.js';
import { ApiError } from '../errors.js';
import { parseOrThrow, variableCreate, variableUpdate } from '../schemas.js';
import { encryptSecret, maskVariableRow } from '../security.js';

/**
 * Variables/secrets per project + environment (09-database/schema.md, 11-security/security.md).
 * Security rule: secret plaintext is NEVER returned by read APIs after creation.
 * List/get/update responses mask secret values as null and expose `hasValue`.
 * Secrets are encrypted at rest (AES-256-GCM) when SECRET_ENCRYPTION_KEY /
 * SERVER_SECRET_KEY is configured; otherwise stored legacy-plaintext (dev only).
 */
const mask = maskVariableRow;

export async function variableRoutes(app: FastifyInstance): Promise<void> {
  // List variables of a project, optionally filtered by environment.
  // Pass ?environmentId=xxx for env-scoped, ?environmentId=null for shared (global).
  app.get('/projects/:projectId/variables', { preHandler: requireAuth }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    await requireProjectAccess(req);
    const { environmentId } = (req.query ?? {}) as { environmentId?: string };
    const where =
      environmentId === undefined
        ? { projectId }
        : environmentId === 'null'
          ? { projectId, environmentId: null }
          : { projectId, environmentId };
    const rows = await db().variable.findMany({ where, orderBy: { key: 'asc' } });
    return rows.map(mask);
  });

  app.post('/projects/:projectId/variables', { preHandler: requireAuth }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    await requireProjectWrite(req);
    const body = parseOrThrow(variableCreate, req.body);
    if (body.environmentId) {
      const env = await db().environment.findUnique({ where: { id: body.environmentId } });
      if (!env || env.projectId !== projectId) {
        throw new ApiError('VALIDATION_ERROR', 'environmentId does not belong to this project', 400);
      }
    }
    // SQLite treats NULLs as distinct, so the @@unique([projectId,
    // environmentId, key]) constraint does NOT stop duplicate shared-scope
    // keys — check explicitly (also deterministic on Postgres).
    const clash = await db().variable.findFirst({
      where: { projectId, environmentId: body.environmentId ?? null, key: body.key },
      select: { id: true },
    });
    if (clash) {
      throw new ApiError('VALIDATION_ERROR', `Variable "${body.key}" already exists in this scope`, 409);
    }
    try {
      const created = await db().variable.create({
        data: {
          projectId,
          environmentId: body.environmentId ?? null,
          key: body.key,
          // Secrets: AES-256-GCM ciphertext when a server key is configured.
          // Plaintext secrets are never echoed back (see mask() above).
          valueEncrypted: (body.isSecret ?? false) ? encryptSecret(body.value) : body.value,
          isSecret: body.isSecret ?? false,
        },
      });
      return reply.code(201).send(mask(created as never));
    } catch {
      throw new ApiError('VALIDATION_ERROR', `Variable "${body.key}" already exists in this scope`, 409);
    }
  });

  app.patch('/variables/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parseOrThrow(variableUpdate, req.body);
    // Encrypt the new value when the row is (or becomes) a secret. When only
    // isSecret flips without a new value we keep the stored cell untouched.
    const existing = await db().variable.findUnique({ where: { id } });
    if (!existing) throw new ApiError('NOT_FOUND', `Variable ${id} not found`, 404);
    await requireWriteAccessToProject(req, existing.projectId);
    // Same NULL-uniqueness reason as create: renaming onto a taken key must fail.
    if (body.key !== undefined && body.key !== existing.key) {
      const clash = await db().variable.findFirst({
        where: { projectId: existing.projectId, environmentId: existing.environmentId, key: body.key },
        select: { id: true },
      });
      if (clash) {
        throw new ApiError('VALIDATION_ERROR', `Variable "${body.key}" already exists in this scope`, 409);
      }
    }
    const willBeSecret = body.isSecret ?? existing.isSecret;
    try {
      const updated = await db().variable.update({
        where: { id },
        data: {
          ...(body.key !== undefined ? { key: body.key } : {}),
          ...(body.value !== undefined ? { valueEncrypted: willBeSecret ? encryptSecret(body.value) : body.value } : {}),
          ...(body.isSecret !== undefined ? { isSecret: body.isSecret } : {}),
        },
      });
      return mask(updated as never);
    } catch {
      throw new ApiError('NOT_FOUND', `Variable ${id} not found`, 404);
    }
  });

  app.delete('/variables/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await db().variable.findUnique({ where: { id }, select: { projectId: true } });
    if (!existing) throw new ApiError('NOT_FOUND', `Variable ${id} not found`, 404);
    await requireWriteAccessToProject(req, existing.projectId);
    try {
      await db().variable.delete({ where: { id } });
    } catch {
      throw new ApiError('NOT_FOUND', `Variable ${id} not found`, 404);
    }
    return reply.code(204).send();
  });
}
