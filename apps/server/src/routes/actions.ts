import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma } from '@prisma/client';
import type { ReusableAction } from '@vietvang/playwright-compiler';
import { db } from '../db.js';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { ApiError } from '../errors.js';
import { parseOrThrow, actionCreate, actionUpdate } from '../schemas.js';
import { validateDefinitionForStore } from '../security.js';
import {
  findReferencingTests,
  parseActionRow,
  requireActionProjectAccess,
} from '../actions.js';

/**
 * P1 reusable actions CRUD (backlog: "Reusable actions/business keywords +
 * Parameters"). Stored in the `Action` table; `definitionJson` holds the
 * full versioned ReusableAction (test-model reusableActionSchema shape).
 *
 * Validation (no silent mutation):
 * - zod boundary shapes (schemas.ts) + explicit cross-field rules here:
 *   parameter names unique; body steps P0-only (nested `callAction`
 *   rejected); unknown step types / forbidden code fields rejected exactly
 *   like test definitions (422 COMPILER_UNSUPPORTED_STEP).
 * - name unique per project (409 ACTION_NAME_CONFLICT on P2002).
 * - DELETE is guarded: an action referenced by a test's `callAction` step
 *   cannot be removed (409 ACTION_IN_USE) — deleting it would break those
 *   tests' next compile explicitly.
 */

function toApi(row: { definitionJson: string }): ReusableAction {
  return parseActionRow(row as { id: string; definitionJson: string });
}

/** Body-step rules for action bodies: P0-only (nested callAction rejected). */
function assertStorableActionBody(
  parameters: Array<{ name: string }>,
  steps: Array<Record<string, unknown>>,
): void {
  const names = parameters.map((p) => p.name);
  if (new Set(names).size !== names.length) {
    throw new ApiError('VALIDATION_ERROR', 'Invalid action: parameter names must be unique', 400);
  }
  const nested = steps.find((s) => s['type'] === 'callAction');
  if (nested) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `Invalid action: nested callAction is rejected (body step "${String(nested['id'] ?? '?')}") — action bodies must be P0 steps so inlining stays total and readable`,
      400,
    );
  }
  // Unknown step types / forbidden code fields: same gate as test definitions.
  const issues = validateDefinitionForStore({ steps });
  if (issues.length > 0) {
    const unsupported = issues.some(
      (i) => i.code === 'STEP_TYPE_UNSUPPORTED' || i.code === 'STEP_FIELD_FORBIDDEN',
    );
    throw new ApiError(
      unsupported ? 'COMPILER_UNSUPPORTED_STEP' : 'VALIDATION_ERROR',
      `Invalid action body: ${issues.map((i) => i.message).join('; ')}`,
      unsupported ? 422 : 400,
      { issues },
    );
  }
}

function conflictOf(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export async function actionRoutes(app: FastifyInstance): Promise<void> {
  // list under project
  app.get('/projects/:projectId/actions', { preHandler: requireAuth }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    await requireProjectAccess(req);
    const rows = await db().action.findMany({
      where: { projectId },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(toApi);
  });

  app.post('/projects/:projectId/actions', { preHandler: requireAuth }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    await requireProjectAccess(req);
    const body = parseOrThrow(actionCreate, req.body);
    const parameters = body.parameters ?? [];
    assertStorableActionBody(parameters, body.steps);
    const action: ReusableAction = {
      schemaVersion: '1.0',
      id: `action_${nanoid(10)}`,
      projectId,
      name: body.name,
      ...(body.description !== undefined ? { description: body.description } : {}),
      parameters: parameters.map((p) => ({
        name: p.name,
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...(p.default !== undefined ? { default: p.default } : {}),
        ...(p.secret !== undefined ? { secret: p.secret } : {}),
      })),
      steps: body.steps as ReusableAction['steps'],
    };
    try {
      const created = await db().action.create({
        data: {
          id: action.id,
          projectId,
          name: action.name,
          description: action.description ?? null,
          definitionJson: JSON.stringify(action),
          createdBy: req.user!.id,
        },
      });
      return reply.code(201).send(toApi(created));
    } catch (err) {
      if (conflictOf(err)) {
        throw new ApiError(
          'ACTION_NAME_CONFLICT',
          `Action name "${body.name}" already exists in this project`,
          409,
        );
      }
      throw err;
    }
  });

  app.get('/actions/:aid', { preHandler: requireAuth }, async (req) => {
    const { aid } = req.params as { aid: string };
    const row = await db().action.findUnique({ where: { id: aid } });
    if (!row) throw new ApiError('NOT_FOUND', `Action ${aid} not found`, 404);
    await requireActionProjectAccess(req, row.projectId);
    return toApi(row);
  });

  app.patch('/actions/:aid', { preHandler: requireAuth }, async (req) => {
    const { aid } = req.params as { aid: string };
    const body = parseOrThrow(actionUpdate, req.body);
    const row = await db().action.findUnique({ where: { id: aid } });
    if (!row) throw new ApiError('NOT_FOUND', `Action ${aid} not found`, 404);
    await requireActionProjectAccess(req, row.projectId);
    const current = toApi(row);
    const next: ReusableAction = {
      ...current,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description ?? undefined } : {}),
      ...(body.parameters !== undefined
        ? {
            parameters: body.parameters.map((p) => ({
              name: p.name,
              ...(p.description !== undefined ? { description: p.description } : {}),
              ...(p.default !== undefined ? { default: p.default } : {}),
              ...(p.secret !== undefined ? { secret: p.secret } : {}),
            })),
          }
        : {}),
      ...(body.steps !== undefined ? { steps: body.steps as ReusableAction['steps'] } : {}),
    };
    assertStorableActionBody(next.parameters, next.steps as unknown as Array<Record<string, unknown>>);
    try {
      const updated = await db().action.update({
        where: { id: aid },
        data: {
          name: next.name,
          description: next.description ?? null,
          definitionJson: JSON.stringify(next),
        },
      });
      return toApi(updated);
    } catch (err) {
      if (conflictOf(err)) {
        throw new ApiError(
          'ACTION_NAME_CONFLICT',
          `Action name "${body.name}" already exists in this project`,
          409,
        );
      }
      throw err;
    }
  });

  app.delete('/actions/:aid', { preHandler: requireAuth }, async (req, reply) => {
    const { aid } = req.params as { aid: string };
    const row = await db().action.findUnique({ where: { id: aid } });
    if (!row) throw new ApiError('NOT_FOUND', `Action ${aid} not found`, 404);
    await requireActionProjectAccess(req, row.projectId);
    const referencing = await findReferencingTests(row.projectId, aid);
    if (referencing.length > 0) {
      throw new ApiError(
        'ACTION_IN_USE',
        `Action ${aid} is used by ${referencing.length} test(s) — remove the callAction step(s) first`,
        409,
        { testIds: referencing },
      );
    }
    await db().action.delete({ where: { id: aid } });
    return reply.code(204).send();
  });
}
