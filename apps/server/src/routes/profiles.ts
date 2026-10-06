import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { db } from '../db.js';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { requireWriteAccessToProject } from '../rbac.js';
import { ApiError } from '../errors.js';
import { parseOrThrow, profileCreate, profileUpdate } from '../schemas.js';
import { decryptSecret, encryptSecret } from '../security.js';

/**
 * P1 wave-2 — auth profiles (stored Playwright storageState, encrypted at rest).
 *
 * - CRUD: GET/POST /projects/:projectId/profiles, GET/PATCH/DELETE /profiles/:pid
 * - Create/update body: { name, environmentId?, storageStateJson }. The state
 *   must be a Playwright storageState shape: an object carrying `cookies[]`
 *   and `origins[]`. Anything else fails with an explicit 400 (never stored).
 * - Read APIs NEVER return plaintext: `stateEncrypted` is stripped and the
 *   response carries `hasValue: true` (same masking contract as variables).
 * - `resolveProfileState()` is the runner-side helper: decrypted state object
 *   for (projectId, environmentId), or null when no profile applies.
 */

type ProfileRow = {
  id: string;
  projectId: string;
  environmentId: string | null;
  name: string;
  stateEncrypted: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type MaskedProfile = Omit<ProfileRow, 'stateEncrypted'> & { hasValue: boolean };

export function maskProfileRow(row: ProfileRow): MaskedProfile {
  const { stateEncrypted: _dropped, ...rest } = row;
  return { ...rest, hasValue: true };
}

/** Light shape check: must look like a Playwright storageState object. */
export function assertStorageStateShape(value: unknown): Record<string, unknown> {
  let obj: unknown = value;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      throw new ApiError('VALIDATION_ERROR', 'storageStateJson must be valid JSON (a Playwright storageState object with cookies[]/origins[])', 400);
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ApiError('VALIDATION_ERROR', 'storageStateJson must be a Playwright storageState object with cookies[]/origins[]', 400);
  }
  const rec = obj as Record<string, unknown>;
  if (!Array.isArray(rec['cookies']) || !Array.isArray(rec['origins'])) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'storageStateJson must be a Playwright storageState object with cookies[]/origins[] (got ' +
        `cookies=${Array.isArray(rec['cookies']) ? 'ok' : typeof rec['cookies']}, ` +
        `origins=${Array.isArray(rec['origins']) ? 'ok' : typeof rec['origins']})`,
      400,
    );
  }
  return rec;
}

async function requireAccessToProject(req: FastifyRequest, projectId: string): Promise<void> {
  if (!req.user) throw new ApiError('UNAUTHORIZED', 'Missing credentials', 401);
  const userRow = await db().user.findUnique({ where: { id: req.user.id } });
  if (userRow?.role === 'admin') return;
  const member = await db().projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: req.user.id } },
  });
  if (!member) throw new ApiError('FORBIDDEN', `No access to project ${projectId}`, 403);
}

async function loadProfileOrThrow(pid: string): Promise<ProfileRow> {
  const row = await db().authProfile.findUnique({ where: { id: pid } });
  if (!row) throw new ApiError('NOT_FOUND', `Auth profile ${pid} not found`, 404);
  return row as ProfileRow;
}

async function checkEnv(projectId: string, environmentId: string | null | undefined): Promise<void> {
  if (environmentId === undefined || environmentId === null) return;
  const env = await db().environment.findUnique({ where: { id: environmentId } });
  if (!env || env.projectId !== projectId) {
    throw new ApiError('VALIDATION_ERROR', 'environmentId does not belong to this project', 400);
  }
}

/**
 * Resolve the stored login state for a run (runner-side, server decrypts).
 * Exact environment match wins; otherwise the environment-agnostic profile
 * (environmentId null, most recently updated) applies; otherwise null.
 * Throws when a matching row exists but cannot be decrypted (missing key).
 */
export async function resolveProfileState(
  projectId: string,
  environmentId?: string | null,
): Promise<Record<string, unknown> | null> {
  const exact = environmentId
    ? await db().authProfile.findFirst({
        where: { projectId, environmentId },
        orderBy: { updatedAt: 'desc' },
      })
    : null;
  const fallback = exact
    ? null
    : await db().authProfile.findFirst({
        where: { projectId, environmentId: null },
        orderBy: { updatedAt: 'desc' },
      });
  const row = exact ?? fallback;
  if (!row) return null;
  const plain = decryptSecret(row.stateEncrypted);
  try {
    return JSON.parse(plain) as Record<string, unknown>;
  } catch {
    throw new Error(`Auth profile ${row.id} holds corrupt storageState JSON`);
  }
}

function conflictOf(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects/:projectId/profiles', { preHandler: requireAuth }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    await requireProjectAccess(req);
    const rows = (await db().authProfile.findMany({
      where: { projectId },
      orderBy: { updatedAt: 'desc' },
    })) as ProfileRow[];
    return rows.map(maskProfileRow);
  });

  app.post('/projects/:projectId/profiles', { preHandler: requireAuth }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    await requireWriteAccessToProject(req, projectId);
    const project = await db().project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError('NOT_FOUND', `Project ${projectId} not found`, 404);
    const body = parseOrThrow(profileCreate, req.body);
    await checkEnv(projectId, body.environmentId);
    const state = assertStorageStateShape(body.storageStateJson);
    try {
      const created = (await db().authProfile.create({
        data: {
          projectId,
          environmentId: body.environmentId ?? null,
          name: body.name,
          stateEncrypted: encryptSecret(JSON.stringify(state)),
          createdBy: req.user!.id,
        },
      })) as ProfileRow;
      return reply.code(201).send(maskProfileRow(created));
    } catch (err) {
      if (conflictOf(err)) {
        throw new ApiError('VALIDATION_ERROR', `Auth profile "${body.name}" already exists in this scope`, 409);
      }
      throw err;
    }
  });

  app.get('/profiles/:pid', { preHandler: requireAuth }, async (req) => {
    const { pid } = req.params as { pid: string };
    const row = await loadProfileOrThrow(pid);
    await requireAccessToProject(req, row.projectId);
    return maskProfileRow(row);
  });

  app.patch('/profiles/:pid', { preHandler: requireAuth }, async (req) => {
    const { pid } = req.params as { pid: string };
    const row = await loadProfileOrThrow(pid);
    await requireWriteAccessToProject(req, row.projectId);
    const body = parseOrThrow(profileUpdate, req.body);
    if (body.environmentId !== undefined) await checkEnv(row.projectId, body.environmentId);
    const state = body.storageStateJson !== undefined ? assertStorageStateShape(body.storageStateJson) : null;
    try {
      const updated = (await db().authProfile.update({
        where: { id: pid },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.environmentId !== undefined ? { environmentId: body.environmentId } : {}),
          ...(state ? { stateEncrypted: encryptSecret(JSON.stringify(state)) } : {}),
        },
      })) as ProfileRow;
      return maskProfileRow(updated);
    } catch (err) {
      if (conflictOf(err)) {
        throw new ApiError('VALIDATION_ERROR', 'Auth profile name already exists in this scope', 409);
      }
      throw err;
    }
  });

  app.delete('/profiles/:pid', { preHandler: requireAuth }, async (req, reply) => {
    const { pid } = req.params as { pid: string };
    const row = await loadProfileOrThrow(pid);
    await requireWriteAccessToProject(req, row.projectId);
    await db().authProfile.delete({ where: { id: pid } });
    return reply.code(204).send();
  });
}
