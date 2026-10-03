import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { copyFile, mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertSafePath,
  isPluginsEnabled,
  pluginsDir,
  readPngDimensions,
  runTest,
  storageRoot,
  type RunRequest,
  type TestDefinition,
} from '@playwright-studio/runner';
import { db } from '../db.js';
import { requireAuth, requirePrivileged, requireProjectAccess } from '../auth.js';
import { ApiError } from '../errors.js';
import { ARTIFACT_MAX_BYTES, checkAllowedHttpUrl, stripServerPaths } from '../security.js';
import { resolveRunInputs } from '../run-inputs.js';
import {
  markQueuedEmittedByRoute,
  prismaRunStore,
  resolveRunVariables,
  runQueue,
  workerPublish,
} from '../runner-store.js';

/**
 * P2 visual regression routes (baselines live in `storage/baselines/`).
 *
 * - Baselines are per-test named PNGs (Prisma `Baseline`, unique testId+name).
 *   Clients only ever see metadata + image bytes — never absolute paths.
 * - `POST /tests/:id/baselines` promotes a run artifact (`visual-<name>.png`
 *   produced by a `visualCheck` step, or an explicit `artifactPath` of that
 *   run) to a baseline: PNG magic + dimensions validated, bytes copied inside
 *   storage (no user-controlled destination paths).
 * - `POST /tests/:id/visual-runs` triggers a run with the baseline map
 *   injected (`VV_BASELINES`) and an optional capture flag (`updateBaselines`
 *   -> `VV_UPDATE_BASELINES=1`). It mirrors `POST /tests/:id/runs` (same
 *   SSRF/env/action/file resolution) so `routes/runs.ts` stays untouched.
 *
 * NOTE (integration seam, documented contract): storing a definition that
 * CONTAINS `visualCheck` steps still requires the one-line allowlist patch in
 * `apps/server/src/security.ts` (`P1_STEP_TYPES + 'visualCheck'`) — this file
 * intentionally does not bypass that guard.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sanitizeVisualFileName(name: string): string {
  const safe = String(name).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 120);
  return `visual-${safe.length > 0 ? safe : 'check'}.png`;
}

const nameParam = z.object({ id: z.string().min(1), name: z.string().min(1).max(200) });
const testParam = z.object({ id: z.string().min(1) });

const promoteBody = z.object({
  name: z.string().min(1).max(200),
  runId: z.string().min(1),
  /** Storage-relative artifact path of that run; defaults to the visual actual. */
  artifactPath: z.string().min(1).max(500).optional(),
});

const visualRunBody = z.object({
  environmentId: z.string().min(1),
  browser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  headed: z.boolean().default(false),
  /** Capture mode: visual steps pass, actuals are promoted afterwards. */
  updateBaselines: z.boolean().default(false),
  /** Load trusted plugins for `plugin:*` steps (Developer/Admin + ALLOW_PLUGINS=1). */
  usePlugins: z.boolean().default(false),
});

function parseOrThrow<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new ApiError('VALIDATION_ERROR', 'Invalid request payload', 400, r.error.flatten());
  return r.data;
}

function toMeta(row: { name: string; width: number | null; height: number | null; createdAt: Date; updatedAt: Date }) {
  return { name: row.name, width: row.width, height: row.height, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/** Run-scoped project membership (requireProjectAccess cannot resolve :runId). */
async function requireRunAccess(req: FastifyRequest, runId: string): Promise<void> {
  if (!req.user) throw new ApiError('UNAUTHORIZED', 'Missing credentials', 401);
  const run = await db().run.findUnique({ where: { id: runId }, select: { projectId: true } });
  if (!run) throw new ApiError('NOT_FOUND', `Run ${runId} not found`, 404);
  const userRow = await db().user.findUnique({ where: { id: req.user.id } });
  if (userRow?.role === 'admin') return;
  const member = await db().projectMember.findUnique({
    where: { projectId_userId: { projectId: run.projectId, userId: req.user.id } },
  });
  if (!member) throw new ApiError('FORBIDDEN', `No access to project ${run.projectId}`, 403);
}

function broadcast(type: string, runId: string, extra: Record<string, unknown> = {}): void {
  const send = (globalThis as { __vvWsBroadcast?: (e: string, p: unknown) => void }).__vvWsBroadcast;
  send?.(type, { runId, at: Date.now(), ...extra });
}

export async function visualRoutes(app: FastifyInstance): Promise<void> {
  // List baseline metadata (never paths or bytes).
  app.get('/tests/:id/baselines', { preHandler: requireAuth }, async (req) => {
    const { id } = parseOrThrow(testParam, req.params);
    await requireProjectAccess(req);
    const test = await db().test.findUnique({ where: { id } });
    if (!test) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    const rows = await db().baseline.findMany({ where: { testId: id }, orderBy: { name: 'asc' } });
    return rows.map(toMeta);
  });

  // Serve one baseline image (bytes only, no path disclosure).
  app.get('/tests/:id/baselines/:name/image', { preHandler: requireAuth }, async (req, reply) => {
    const { id, name } = parseOrThrow(nameParam, req.params);
    await requireProjectAccess(req);
    const row = await db().baseline.findUnique({ where: { testId_name: { testId: id, name } } });
    if (!row) throw new ApiError('NOT_FOUND', `Baseline "${name}" not found for test ${id}`, 404);
    let bytes: Buffer;
    try {
      bytes = await readFile(assertSafePath(storageRoot(), row.path));
    } catch {
      throw new ApiError('NOT_FOUND', `Baseline "${name}" bytes are missing from storage`, 404);
    }
    return reply.header('content-type', 'image/png').header('content-length', bytes.length).send(bytes);
  });

  // Promote a run artifact to a baseline (copy inside storage, PNG-validated).
  app.post('/tests/:id/baselines', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = parseOrThrow(testParam, req.params);
    await requireProjectAccess(req);
    const body = parseOrThrow(promoteBody, req.body);
    const test = await db().test.findUnique({ where: { id } });
    if (!test) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    const run = await db().run.findUnique({ where: { id: body.runId } });
    if (!run || run.testId !== id) {
      throw new ApiError('VALIDATION_ERROR', `runId '${body.runId}' does not belong to test ${id}`, 400);
    }
    if (body.name.includes('/') || body.name.includes('\\')) {
      throw new ApiError('VALIDATION_ERROR', 'baseline name must not contain path separators', 400);
    }
    const artifactPath = body.artifactPath ?? `runs/${body.runId}/screenshots/${sanitizeVisualFileName(body.name)}`;
    if (!artifactPath.startsWith(`runs/${body.runId}/`) || !artifactPath.toLowerCase().endsWith('.png')) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `artifactPath must be a .png under runs/${body.runId}/ (got "${artifactPath}")`,
        400,
      );
    }
    const artifact = await db().artifact.findFirst({ where: { runId: body.runId, path: artifactPath } });
    if (!artifact) {
      throw new ApiError('VALIDATION_ERROR', `artifact "${artifactPath}" is not recorded for run ${body.runId}`, 400);
    }
    const abs = assertSafePath(storageRoot(), artifactPath);
    let bytes: Buffer;
    try {
      const st = await stat(abs);
      if (!st.isFile() || st.size > ARTIFACT_MAX_BYTES) {
        throw new ApiError('VALIDATION_ERROR', `artifact "${artifactPath}" is not a promotable file`, 400);
      }
      bytes = await readFile(abs);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError('NOT_FOUND', `artifact "${artifactPath}" bytes are missing from storage`, 404);
    }
    if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) {
      throw new ApiError('VALIDATION_ERROR', `artifact "${artifactPath}" is not a PNG (bad magic)`, 400);
    }
    let dims: { width: number; height: number };
    try {
      dims = readPngDimensions(bytes);
    } catch (err) {
      throw new ApiError('VALIDATION_ERROR', `artifact "${artifactPath}" is not a decodable PNG: ${(err as Error).message}`, 400);
    }
    const existing = await db().baseline.findUnique({ where: { testId_name: { testId: id, name: body.name } } });
    if (existing) {
      await copyFile(abs, assertSafePath(storageRoot(), existing.path));
      const updated = await db().baseline.update({
        where: { id: existing.id },
        data: { width: dims.width, height: dims.height, createdBy: (req as FastifyRequest).user!.id },
      });
      return reply.code(200).send(toMeta(updated));
    }
    const created = await db().baseline.create({
      data: {
        projectId: test.projectId,
        testId: id,
        name: body.name,
        path: 'baselines/pending',
        width: dims.width,
        height: dims.height,
        createdBy: (req as FastifyRequest).user!.id,
      },
    });
    const rel = `baselines/${created.id}.png`;
    await mkdir(join(storageRoot(), 'baselines'), { recursive: true });
    await copyFile(abs, assertSafePath(storageRoot(), rel));
    const saved = await db().baseline.update({ where: { id: created.id }, data: { path: rel } });
    return reply.code(201).send(toMeta(saved));
  });

  // Delete a baseline (row + bytes, best effort on bytes).
  app.delete('/tests/:id/baselines/:name', { preHandler: requireAuth }, async (req, reply) => {
    const { id, name } = parseOrThrow(nameParam, req.params);
    await requireProjectAccess(req);
    const row = await db().baseline.findUnique({ where: { testId_name: { testId: id, name } } });
    if (!row) throw new ApiError('NOT_FOUND', `Baseline "${name}" not found for test ${id}`, 404);
    await db().baseline.delete({ where: { id: row.id } });
    try {
      await unlink(assertSafePath(storageRoot(), row.path));
    } catch {
      // DB row is gone; a missing byte file needs no further action.
    }
    return reply.code(204).send();
  });

  // Serve one recorded run artifact image by id (for baseline/actual/diff
  // side-by-side views). DB-anchored (no client-supplied paths), images only.
  app.get('/runs/:runId/artifacts/:artifactId/image', { preHandler: requireAuth }, async (req, reply) => {
    const params = parseOrThrow(
      z.object({ runId: z.string().min(1), artifactId: z.string().min(1) }),
      req.params,
    );
    // requireProjectAccess() only resolves `params.id`/`params.projectId`,
    // so run-scoped membership is checked explicitly here (mirrors files.ts).
    await requireRunAccess(req, params.runId);
    const row = await db().artifact.findUnique({ where: { id: params.artifactId } });
    if (!row || row.runId !== params.runId) {
      throw new ApiError('NOT_FOUND', `Artifact ${params.artifactId} not found for run ${params.runId}`, 404);
    }
    if (!row.mimeType?.startsWith('image/')) {
      throw new ApiError('VALIDATION_ERROR', `Artifact ${params.artifactId} is not an image`, 400);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(assertSafePath(storageRoot(), row.path));
    } catch {
      throw new ApiError('NOT_FOUND', `Artifact ${params.artifactId} bytes are missing from storage`, 404);
    }
    return reply.header('content-type', row.mimeType).header('content-length', bytes.length).send(bytes);
  });

  // Download any recorded run artifact by id (trace.zip, video.webm, …).
  // DB-anchored (no client-supplied paths); same run-membership gate as /image.
  app.get('/runs/:runId/artifacts/:artifactId/download', { preHandler: requireAuth }, async (req, reply) => {
    const params = parseOrThrow(
      z.object({ runId: z.string().min(1), artifactId: z.string().min(1) }),
      req.params,
    );
    await requireRunAccess(req, params.runId);
    const row = await db().artifact.findUnique({ where: { id: params.artifactId } });
    if (!row || row.runId !== params.runId) {
      throw new ApiError('NOT_FOUND', `Artifact ${params.artifactId} not found for run ${params.runId}`, 404);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(assertSafePath(storageRoot(), row.path));
    } catch {
      throw new ApiError('NOT_FOUND', `Artifact ${params.artifactId} bytes are missing from storage`, 404);
    }
    const fileName = row.path.split('/').pop() ?? `${params.artifactId}.bin`;
    return reply
      .header('content-type', row.mimeType ?? 'application/octet-stream')
      .header('content-length', bytes.length)
      .header('content-disposition', `attachment; filename="${fileName}"`)
      .send(bytes);
  });

  // Trigger a visual run: baseline map injected, optional capture/plugins.
  app.post('/tests/:id/visual-runs', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = parseOrThrow(testParam, req.params);
    await requireProjectAccess(req);
    const body = parseOrThrow(visualRunBody, req.body);
    const test = await db().test.findUnique({ where: { id } });
    if (!test) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    if (body.usePlugins) {
      requirePrivileged(req);
      if (!isPluginsEnabled()) {
        throw new ApiError(
          'FORBIDDEN',
          'Plugin runs are disabled (set ALLOW_PLUGINS=1 after Developer/Admin review of PLUGINS_DIR)',
          403,
        );
      }
    }
    const env = await db().environment.findUnique({ where: { id: body.environmentId } });
    if (!env || env.projectId !== test.projectId) {
      throw new ApiError('VALIDATION_ERROR', 'environmentId does not belong to this project', 400);
    }
    const project = await db().project.findUnique({ where: { id: test.projectId } });
    const urlCheck = checkAllowedHttpUrl(env.baseUrl ?? project?.baseUrl ?? null);
    if (!urlCheck.ok) throw new ApiError('VALIDATION_ERROR', `run target rejected: ${urlCheck.reason}`, 400);

    const run = await db().run.create({
      data: {
        projectId: test.projectId,
        testId: id,
        environmentId: body.environmentId,
        browser: body.browser,
        status: 'queued',
        trigger: 'visual',
      },
    });
    broadcast('run.queued', run.id, { testId: id });
    markQueuedEmittedByRoute(run.id);
    const definition = JSON.parse(test.definitionJson) as TestDefinition;
    const { projectVariables, environmentVariables } = await resolveRunVariables(test.projectId, body.environmentId);
    const inputs = await resolveRunInputs(test.projectId, definition, { environmentId: body.environmentId });
    // Baseline map: DB rows with existing bytes only (a missing file fails
    // explicitly inside the worker as VISUAL_BASELINE_MISSING, never silent).
    const baselineRows = await db().baseline.findMany({ where: { testId: id } });
    const baselines: Record<string, string> = {};
    for (const b of baselineRows) {
      try {
        const abs = assertSafePath(storageRoot(), b.path);
        await stat(abs);
        baselines[b.name] = abs;
      } catch {
        // byte file gone — worker reports it explicitly per visualCheck name
      }
    }
    const request: RunRequest = {
      runId: run.id,
      test: definition,
      projectId: test.projectId,
      environmentId: body.environmentId,
      browser: body.browser,
      headed: body.headed,
      ...(Object.keys(baselines).length > 0 ? { baselines } : {}),
      ...(body.updateBaselines ? { updateBaselines: true } : {}),
      ...(body.usePlugins ? { pluginsDir: pluginsDir() } : {}),
      ...(inputs.actions.length > 0 ? { actions: inputs.actions } : {}),
      ...(inputs.filePaths !== undefined ? { filePaths: inputs.filePaths } : {}),
      ...(inputs.storageStateJson !== undefined ? { storageStateJson: inputs.storageStateJson } : {}),
      projectVariables,
      environmentVariables,
      trigger: 'visual',
      triggeredBy: req.user!.id,
    };
    void runQueue
      .submit(run.id, async () => {
        const current = await prismaRunStore.getRun(run.id);
        if (current?.status === 'cancelled') return { status: 'cancelled' as const, runId: run.id };
        return runTest(request, { store: prismaRunStore, publish: workerPublish });
      })
      .catch(async (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        await prismaRunStore.updateRun(run.id, {
          status: 'failed',
          finishedAt: Date.now(),
          errorSummary: stripServerPaths(`Worker crashed before settling: ${message}`),
        });
      });
    return reply.code(202).send(run);
  });
}
