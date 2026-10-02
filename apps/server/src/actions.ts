import type { FastifyRequest } from 'fastify';
import type { ReusableAction } from '@vietvang/playwright-compiler';
import { ApiError } from './errors.js';
import { db } from './db.js';

/**
 * P1 reusable-action store helpers (backlog: "Reusable actions/business
 * keywords + Parameters"). Actions live in the `Action` table
 * (project-scoped, name-unique); `definitionJson` holds the full
 * versioned ReusableAction per test-model reusableActionSchema.
 */

/** Parse one stored Action row into a ReusableAction (throws 500 on corruption). */
export function parseActionRow(row: { id: string; definitionJson: string }): ReusableAction {
  try {
    return JSON.parse(row.definitionJson) as ReusableAction;
  } catch {
    throw new ApiError('VALIDATION_ERROR', `Stored action ${row.id} is not valid JSON`, 500);
  }
}

/** Load + parse every action of a project (compile/run resolution). */
export async function loadProjectActions(projectId: string): Promise<ReusableAction[]> {
  const rows = await db().action.findMany({
    where: { projectId },
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map(parseActionRow);
}

/** Actions keyed by id for compileTest/runner { actions } contexts. */
export function actionMap(actions: ReusableAction[]): Map<string, ReusableAction> {
  return new Map(actions.map((a) => [a.id, a]));
}

/**
 * Project membership for /actions/:aid routes. requireProjectAccess() cannot
 * resolve the `aid` param (it only knows `projectId`/`id`), so membership is
 * checked explicitly against the action's own project. Mirrors auth.ts.
 */
export async function requireActionProjectAccess(
  req: FastifyRequest,
  projectId: string,
): Promise<void> {
  if (!req.user) throw new ApiError('UNAUTHORIZED', 'Missing credentials', 401);
  const userRow = await db().user.findUnique({ where: { id: req.user.id } });
  if (userRow?.role === 'admin') return;
  const member = await db().projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: req.user.id } },
  });
  if (!member) throw new ApiError('FORBIDDEN', `No access to project ${projectId}`, 403);
}

/** Tests whose definition calls this action (used to guard deletes). */
export async function findReferencingTests(
  projectId: string,
  actionId: string,
): Promise<string[]> {
  const tests = await db().test.findMany({ where: { projectId } });
  const hits: string[] = [];
  for (const t of tests) {
    try {
      const def = JSON.parse(t.definitionJson) as { steps?: unknown };
      if (
        Array.isArray(def.steps) &&
        def.steps.some(
          (s) =>
            s !== null &&
            typeof s === 'object' &&
            (s as Record<string, unknown>)['type'] === 'callAction' &&
            (s as Record<string, unknown>)['actionId'] === actionId,
        )
      ) {
        hits.push(t.id);
      }
    } catch {
      // Corrupt test definitions are another route's problem; ignore here.
    }
  }
  return hits;
}
