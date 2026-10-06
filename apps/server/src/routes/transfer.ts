import type { FastifyInstance } from 'fastify';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { assertSafePath, storageRoot } from '@playwright-studio/runner';
import { db } from '../db.js';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { requireGlobalWriter } from '../rbac.js';
import { ApiError } from '../errors.js';
import { parseOrThrow, projectImport, type ProjectExportPayload } from '../schemas.js';
import { decryptSecret, encryptSecret, validateDefinitionForStore } from '../security.js';
import { assertValidCron } from './schedules.js';
import { decodeFileBase64ForImport, sanitizeFileName } from './files.js';

/**
 * P1 wave-2 — project export/import (portable JSON).
 *
 * Export (`GET /projects/:projectId/export?format=json`):
 * - One JSON document: project, environments, variables, tests (definitions),
 *   actions, suites + ordered memberships, schedules, files (metadata +
 *   contentBase64 so the document is self-contained/portable).
 * - Secrets are NEVER exported: secret variables carry only
 *   { key, environmentId, isSecret: true, hasValue: true } — no value.
 * - Total cap 50 MB (files + definitions pre-summed); over-cap fails with an
 *   explicit 400 instead of truncating.
 *
 * Import (`POST /projects/import { name?, payload }`):
 * - Validates the payload with zod (fail explicit, never partial import:
 *   every row is created only after the whole payload validates).
 * - Creates a NEW project and remaps EVERY id (fresh cuids; embedded
 *   `test_…`/`action_…` ids regenerated; callAction/fileId references
 *   rewritten through the old→new maps).
 * - Name conflicts resolve to "<name> (imported)" (then " (imported N)").
 * - Test versions restart at 1; secret variables are created BLANK
 *   (isSecret kept, value empty — the importer must refill them).
 */

export const EXPORT_MAX_BYTES = 50 * 1024 * 1024;
export const IMPORT_BODY_LIMIT = 60 * 1024 * 1024;

function plainValue(stored: string): string {
  try {
    return decryptSecret(stored);
  } catch {
    return stored;
  }
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Rewrite embedded cross-references to the import's new ids. */
function remapRefs(
  node: unknown,
  maps: { actions: Map<string, string>; files: Map<string, string> },
  projectId: string,
): unknown {
  if (Array.isArray(node)) return node.map((v) => remapRefs(v, maps, projectId));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'actionId' && typeof v === 'string' && maps.actions.has(v)) {
        out[k] = maps.actions.get(v);
      } else if (k === 'fileId' && typeof v === 'string' && maps.files.has(v)) {
        out[k] = maps.files.get(v);
      } else if (k === 'projectId') {
        out[k] = projectId;
      } else {
        out[k] = remapRefs(v, maps, projectId);
      }
    }
    return out;
  }
  return node;
}

function assertStorableSteps(steps: unknown, what: string): void {
  const issues = validateDefinitionForStore({ steps });
  if (issues.length > 0) {
    throw new ApiError('VALIDATION_ERROR', `Import failed: ${what} is invalid: ${issues.map((i) => i.message).join('; ')}`, 400);
  }
}

export async function transferRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects/:projectId/export', { preHandler: requireAuth }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    await requireProjectAccess(req);
    const { format } = (req.query ?? {}) as { format?: string };
    if (format !== undefined && format !== 'json') {
      throw new ApiError('VALIDATION_ERROR', 'Only format=json is supported', 400);
    }
    const project = await db().project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError('NOT_FOUND', `Project ${projectId} not found`, 404);

    const [envs, variables, tests, actions, suites, schedules, files] = await Promise.all([
      db().environment.findMany({ where: { projectId }, orderBy: { name: 'asc' } }),
      db().variable.findMany({ where: { projectId }, orderBy: { key: 'asc' } }),
      db().test.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
      db().action.findMany({ where: { projectId }, orderBy: { name: 'asc' } }),
      db().testSuite.findMany({
        where: { projectId },
        orderBy: { createdAt: 'asc' },
        include: { tests: { orderBy: { sortOrder: 'asc' } } },
      }),
      db().schedule.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
      db().fileAsset.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
    ]);

    // Pre-cap BEFORE base64 amplification: fail explicit instead of truncating.
    const defBytes = tests.reduce((n, t) => n + byteLength(t.definitionJson), 0)
      + actions.reduce((n, a) => n + byteLength(a.definitionJson), 0);
    const fileBytes = files.reduce((n, f) => n + f.sizeBytes, 0);
    if (defBytes + fileBytes > EXPORT_MAX_BYTES) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `Project export would be ~${defBytes + fileBytes} bytes (max ${EXPORT_MAX_BYTES}) — delete unused files or split the project`,
        400,
      );
    }

    const filePayloads = [];
    for (const f of files) {
      let bytes: Buffer;
      try {
        bytes = await readFile(assertSafePath(storageRoot(), f.path));
      } catch {
        throw new ApiError('VALIDATION_ERROR', `Export failed: file ${f.id} ("${f.name}") bytes are missing from storage`, 400);
      }
      filePayloads.push({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        contentBase64: bytes.toString('base64'),
      });
    }

    const payload: ProjectExportPayload = {
      version: 1,
      project: {
        name: project.name,
        description: project.description,
        baseUrl: project.baseUrl,
      },
      environments: envs.map((e) => ({
        id: e.id,
        name: e.name,
        baseUrl: e.baseUrl,
        isDefault: e.isDefault,
      })),
      variables: variables.map((v) =>
        v.isSecret
          ? { key: v.key, environmentId: v.environmentId, isSecret: true as const, hasValue: true as const }
          : { key: v.key, environmentId: v.environmentId, isSecret: false as const, value: plainValue(v.valueEncrypted) },
      ),
      tests: tests.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        status: t.status,
        definition: JSON.parse(t.definitionJson) as Record<string, unknown>,
      })),
      actions: actions.map((a) => {
        const def = JSON.parse(a.definitionJson) as {
          parameters?: unknown;
          steps?: unknown;
        };
        return {
          id: a.id,
          name: a.name,
          description: a.description,
          parameters: Array.isArray(def.parameters) ? (def.parameters as Array<Record<string, unknown>>) : undefined,
          steps: (Array.isArray(def.steps) ? def.steps : []) as Array<Record<string, unknown>>,
        };
      }),
      suites: suites.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        testIds: s.tests.map((m) => m.testId),
      })),
      schedules: schedules.map((s) => ({
        ...(s.suiteId ? { suiteId: s.suiteId } : {}),
        ...(s.testId ? { testId: s.testId } : {}),
        environmentId: s.environmentId,
        cron: s.cron,
        enabled: s.enabled,
        retries: s.retries,
        ...(s.notifyOnFailure ? { notifyOnFailure: true as const } : {}),
      })),
      files: filePayloads,
    };
    return payload;
  });

  app.post(
    '/projects/import',
    { preHandler: requireAuth, bodyLimit: IMPORT_BODY_LIMIT },
    async (req, reply) => {
      await requireGlobalWriter(req);
      const body = parseOrThrow(projectImport, req.body);
      const payload = body.payload;

      // Whole-payload validation BEFORE creating anything (no partial imports).
      if (payload.tests.some((t) => typeof t.definition !== 'object' || t.definition === null)) {
        throw new ApiError('VALIDATION_ERROR', 'Import failed: every test needs a definition object', 400);
      }
      const actionNames = payload.actions.map((a) => a.name);
      if (new Set(actionNames).size !== actionNames.length) {
        throw new ApiError('VALIDATION_ERROR', 'Import failed: action names must be unique', 400);
      }
      for (const a of payload.actions) assertStorableSteps(a.steps, `action "${a.name}"`);
      for (const t of payload.tests) {
        const steps = (t.definition as Record<string, unknown>)['steps'];
        assertStorableSteps(steps, `test "${t.name}"`);
      }
      for (const s of payload.schedules) {
        if ((s.suiteId ? 1 : 0) + (s.testId ? 1 : 0) !== 1) {
          throw new ApiError('VALIDATION_ERROR', 'Import failed: every schedule needs exactly one of suiteId/testId', 400);
        }
        assertValidCron(s.cron);
      }
      const suiteTestIds = new Set(payload.tests.map((t) => t.id));
      for (const s of payload.suites) {
        for (const tid of s.testIds) {
          if (!suiteTestIds.has(tid)) {
            throw new ApiError('VALIDATION_ERROR', `Import failed: suite "${s.name}" references unknown test id ${tid}`, 400);
          }
        }
      }
      const envIds = new Set(payload.environments.map((e) => e.id));
      if (new Set(payload.environments.map((e) => e.name)).size !== payload.environments.length) {
        throw new ApiError('VALIDATION_ERROR', 'Import failed: environment names must be unique', 400);
      }
      for (const v of payload.variables) {
        if (v.environmentId !== undefined && v.environmentId !== null && !envIds.has(v.environmentId)) {
          throw new ApiError('VALIDATION_ERROR', `Import failed: variable "${v.key}" references unknown environment`, 400);
        }
        if (!v.isSecret && typeof v.value !== 'string') {
          throw new ApiError('VALIDATION_ERROR', `Import failed: non-secret variable "${v.key}" needs a value`, 400);
        }
      }

      // Name conflict → "<name> (imported)" (then numbered) — never clobbers.
      let name = (body.name ?? payload.project.name).trim() || 'Imported project';
      if (await db().project.findFirst({ where: { name } })) {
        name = `${name} (imported)`;
        let n = 2;
        while (await db().project.findFirst({ where: { name } })) {
          name = `${name.replace(/ \(imported( \d+)?\)$/, '')} (imported ${n++})`;
        }
      }

      const project = await db().project.create({
        data: {
          name,
          description: payload.project.description ?? null,
          baseUrl: payload.project.baseUrl ?? null,
        },
      });
      const userRow = await db().user.findUnique({ where: { id: req.user!.id } });
      if (userRow) {
        await db().projectMember.upsert({
          where: { projectId_userId: { projectId: project.id, userId: userRow.id } },
          update: { role: 'owner' },
          create: { projectId: project.id, userId: userRow.id, role: 'owner' },
        });
      }

      try {
        const newEnv = new Map<string, string>();
        let defaultTaken = false;
        for (const e of payload.environments) {
          const created = await db().environment.create({
            data: {
              projectId: project.id,
              name: e.name,
              baseUrl: e.baseUrl ?? null,
              isDefault: e.isDefault === true && !defaultTaken,
            },
          });
          if (e.isDefault === true) defaultTaken = true;
          newEnv.set(e.id, created.id);
        }

        for (const v of payload.variables) {
          const environmentId = v.environmentId === undefined || v.environmentId === null
            ? null
            : newEnv.get(v.environmentId)!;
          await db().variable.create({
            data: {
              projectId: project.id,
              environmentId,
              key: v.key,
              // Secrets import BLANK (value never travels in exports) — the
              // importer refills them; isSecret is preserved.
              valueEncrypted: v.isSecret ? encryptSecret('') : (v.value as string),
              isSecret: v.isSecret,
            },
          });
        }

        const newFile = new Map<string, string>();
        let filesTotal = 0;
        await mkdir(join(storageRoot(), 'files'), { recursive: true });
        for (const f of payload.files) {
          const buf = decodeFileBase64ForImport(f.contentBase64, f.name);
          filesTotal += buf.length;
          if (filesTotal > 100 * 1024 * 1024) {
            throw new ApiError('VALIDATION_ERROR', 'Import failed: files exceed the 100 MB/project cap', 400);
          }
          const safe = sanitizeFileName(f.name);
          const created = await db().fileAsset.create({
            data: {
              projectId: project.id,
              name: safe,
              mimeType: typeof f.mimeType === 'string' ? f.mimeType : null,
              sizeBytes: buf.length,
              path: 'files/pending',
              createdBy: req.user!.id,
            },
          });
          const rel = `files/${created.id}-${safe}`;
          await writeFile(assertSafePath(storageRoot(), rel), buf);
          await db().fileAsset.update({ where: { id: created.id }, data: { path: rel } });
          newFile.set(f.id, created.id);
        }

        const newAction = new Map<string, string>();
        for (const a of payload.actions) {
          const id = `action_${nanoid(10)}`;
          const def = {
            schemaVersion: '1.0',
            id,
            projectId: project.id,
            name: a.name,
            ...(a.description ? { description: a.description } : {}),
            parameters: a.parameters ?? [],
            steps: a.steps,
          };
          await db().action.create({
            data: {
              id,
              projectId: project.id,
              name: a.name,
              description: a.description ?? null,
              definitionJson: JSON.stringify(def),
              createdBy: req.user!.id,
            },
          });
          newAction.set(a.id, id);
        }

        const maps = { actions: newAction, files: newFile };
        const newTest = new Map<string, string>();
        for (const t of payload.tests) {
          const remapped = remapRefs(t.definition, maps, project.id) as Record<string, unknown>;
          remapped['id'] = `test_${nanoid(10)}`;
          const definitionJson = JSON.stringify(remapped);
          const created = await db().test.create({
            data: {
              projectId: project.id,
              name: t.name,
              description: t.description ?? null,
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
              changeMessage: 'imported',
            },
          });
          newTest.set(t.id, created.id);
        }

        const newSuite = new Map<string, string>();
        for (const s of payload.suites) {
          const created = await db().testSuite.create({
            data: {
              projectId: project.id,
              name: s.name,
              description: s.description ?? null,
              createdBy: req.user!.id,
            },
          });
          await db().suiteTest.createMany({
            data: s.testIds.map((tid, i) => ({
              suiteId: created.id,
              testId: newTest.get(tid)!,
              sortOrder: i,
            })),
          });
          newSuite.set(s.id, created.id);
        }

        for (const s of payload.schedules) {
          const environmentId = newEnv.get(s.environmentId);
          if (!environmentId) {
            throw new ApiError('VALIDATION_ERROR', 'Import failed: schedule references unknown environment', 400);
          }
          const suiteId = s.suiteId ? newSuite.get(s.suiteId) : null;
          const testId = s.testId ? newTest.get(s.testId) : null;
          if ((suiteId ? 1 : 0) + (testId ? 1 : 0) !== 1) {
            throw new ApiError('VALIDATION_ERROR', 'Import failed: schedule target did not remap cleanly', 400);
          }
          await db().schedule.create({
            data: {
              projectId: project.id,
              suiteId,
              testId,
              environmentId,
              cron: s.cron,
              enabled: s.enabled ?? true,
              retries: s.retries ?? 0,
              notifyOnFailure: s.notifyOnFailure ?? false,
              createdBy: req.user!.id,
            },
          });
        }

        const counts = {
          environments: payload.environments.length,
          variables: payload.variables.length,
          tests: payload.tests.length,
          actions: payload.actions.length,
          suites: payload.suites.length,
          schedules: payload.schedules.length,
          files: payload.files.length,
        };
        return reply.code(201).send({ project, counts });
      } catch (err) {
        // No partial imports: roll back the whole project on any row failure.
        await db().project.delete({ where: { id: project.id } }).catch(() => {});
        throw err;
      }
    },
  );
}
