import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db.js';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { ApiError } from '../errors.js';
import { parseOrThrow, integrationCreate, integrationUpdate, bugReportCreate } from '../schemas.js';
import {
  PROVIDERS,
  buildBugMarkdown,
  decryptSecrets,
  encryptSecrets,
  parseProvider,
  sendToProvider,
} from '../integrations.js';
import { stripServerPaths } from '../security.js';
import { assertSafePath, storageRoot } from '@playwright-studio/runner';

/**
 * Outbound integrations (bug-from-failure).
 * - CRUD: GET/POST /projects/:projectId/integrations, PATCH/DELETE /integrations/:id.
 *   Secrets are write-only (masked as { present:true } on read, never plaintext).
 * - GET /runs/:id/bug-preview → deterministic markdown (no send).
 * - POST /runs/:id/bug-report {integrationId?, summary?} → send to one
 *   integration (jira/backlog/slack/lark). Markdown (.md) download is
 *   client-side from the preview. Tester decides; nothing auto-files.
 */

function mask(row: { id: string; projectId: string; provider: string; name: string; enabled: boolean; secretJson: string; configJson: string; createdAt: Date; updatedAt: Date }) {
  const secretKeys = Object.keys(decryptSecrets(row.secretJson));
  let config: Record<string, string> = {};
  try {
    const raw: unknown = JSON.parse(row.configJson || '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      config = raw as Record<string, string>;
    }
  } catch {
    config = {};
  }
  return {
    id: row.id,
    projectId: row.projectId,
    provider: row.provider,
    name: row.name,
    enabled: row.enabled,
    config,
    secretFields: PROVIDERS[row.provider as keyof typeof PROVIDERS]?.secretFields ?? [],
    secretKeys,
    hasSecrets: row.secretJson.length > 2,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function requireIntegrationAccess(req: FastifyRequest, projectId: string): Promise<void> {
  (req.params as Record<string, unknown>).projectId = projectId;
  await requireProjectAccess(req);
}

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects/:projectId/integrations', { preHandler: requireAuth }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    await requireProjectAccess(req);
    const rows = await db().integration.findMany({ where: { projectId }, orderBy: { name: 'asc' } });
    return rows.map(mask);
  });

  app.post('/projects/:projectId/integrations', { preHandler: requireAuth }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    await requireProjectAccess(req);
    const body = parseOrThrow(integrationCreate, req.body);
    const provider = parseProvider(body.provider);
    const project = await db().project.findUnique({ where: { id: projectId } });
    if (!project) throw new ApiError('NOT_FOUND', `Project ${projectId} not found`, 404);
    try {
      const created = await db().integration.create({
        data: {
          projectId,
          provider,
          name: body.name,
          enabled: body.enabled ?? true,
          configJson: JSON.stringify(body.config ?? {}),
          secretJson: encryptSecrets(body.secrets ?? {}),
        },
      });
      return reply.code(201).send(mask(created));
    } catch {
      throw new ApiError('VALIDATION_ERROR', `Integration "${body.name}" already exists for ${provider}`, 409);
    }
  });

  app.patch('/integrations/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await db().integration.findUnique({ where: { id } });
    if (!row) throw new ApiError('NOT_FOUND', `Integration ${id} not found`, 404);
    await requireIntegrationAccess(req, row.projectId);
    const body = parseOrThrow(integrationUpdate, req.body);
    const updated = await db().integration.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.config !== undefined ? { configJson: JSON.stringify(body.config) } : {}),
        ...(body.secrets !== undefined ? { secretJson: encryptSecrets(body.secrets) } : {}),
      },
    });
    return mask(updated);
  });

  app.delete('/integrations/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await db().integration.findUnique({ where: { id } });
    if (!row) throw new ApiError('NOT_FOUND', `Integration ${id} not found`, 404);
    await requireIntegrationAccess(req, row.projectId);
    await db().integration.delete({ where: { id } });
    return reply.code(204).send();
  });

  app.get('/runs/:id/bug-preview', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    await requireProjectAccess(req);
    return bugContextOf(id);
  });

  app.post('/runs/:id/bug-report', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await requireProjectAccess(req);
    const body = parseOrThrow(bugReportCreate, req.body);
    const ctx = await bugContextOf(id);
    const title = body.summary ?? ctx.title;
    if (!body.integrationId) {
      // Preview only (markdown download is client-side).
      return { title, markdown: ctx.markdown, delivery: null };
    }
    const row = await db().integration.findUnique({ where: { id: body.integrationId } });
    if (!row) throw new ApiError('NOT_FOUND', `Integration ${body.integrationId} not found`, 404);
    if (!row.enabled) throw new ApiError('VALIDATION_ERROR', `Integration "${row.name}" is disabled`, 400);
    const run = await db().run.findUnique({ where: { id } });
    if (!run || run.projectId !== row.projectId) {
      throw new ApiError('VALIDATION_ERROR', 'Integration belongs to a different project', 400);
    }
    const provider = parseProvider(row.provider);
    let config: Record<string, string> = {};
    try {
      const raw: unknown = JSON.parse(row.configJson || '{}');
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) config = raw as Record<string, string>;
    } catch {
      config = {};
    }
    // Optional screenshot attachments (Backlog): read PNG bytes from storage.
    // Capped (5 files, 8 MB total) so a huge run cannot exhaust memory.
    let attachments: Array<{ filename: string; bytes: Buffer; mimeType: string }> | undefined;
    if (body.attachScreenshots === true && provider === 'backlog') {
      const { readFile } = await import('node:fs/promises');
      attachments = [];
      let total = 0;
      const shots = (await db().artifact.findMany({ where: { runId: id, type: 'screenshot' }, orderBy: { createdAt: 'asc' } })).slice(0, 5);
      for (const a of shots) {
        try {
          const bytes = await readFile(assertSafePath(storageRoot(), a.path));
          if (total + bytes.length > 8 * 1024 * 1024) break;
          total += bytes.length;
          attachments.push({ filename: a.path.split('/').pop() ?? `${a.id}.png`, bytes, mimeType: a.mimeType ?? 'image/png' });
        } catch {
          continue;
        }
      }
    }
    const delivery = await sendToProvider(provider, config, decryptSecrets(row.secretJson), {
      title,
      markdown: ctx.markdown,
      ...(attachments !== undefined ? { attachments } : {}),
    });
    await db().auditLog.create({
      data: {
        projectId: row.projectId,
        userId: req.user!.id,
        action: 'bug.report',
        entityType: 'run',
        entityId: id,
        details: JSON.stringify({ integrationId: row.id, provider, externalId: delivery.externalId ?? null }),
      },
    }).catch(() => undefined);
    return reply.code(201).send({ title, markdown: ctx.markdown, delivery });
  });
}

async function bugContextOf(runId: string): Promise<{ title: string; markdown: string }> {
  const run = await db().run.findUnique({
    where: { id: runId },
    include: { steps: true, artifacts: true, test: { select: { name: true } } },
  });
  if (!run) throw new ApiError('NOT_FOUND', `Run ${runId} not found`, 404);
  const env = run.environmentId ? await db().environment.findUnique({ where: { id: run.environmentId } }) : null;
  const err = run.errorSummary ? stripServerPaths(run.errorSummary) : null;
  return buildBugMarkdown({
    testName: run.test?.name ?? run.testId,
    runId: run.id,
    status: run.status,
    browser: run.browser,
    environment: env?.name ?? null,
    startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
    finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
    durationMs: run.durationMs,
    errorSummary: err,
    steps: run.steps.map((s) => ({
      stepId: s.stepId,
      status: s.status,
      errorMessage: s.errorMessage ? stripServerPaths(s.errorMessage) : null,
      durationMs: s.durationMs,
    })),
    artifacts: run.artifacts.map((a) => ({ type: a.type, path: a.path, mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
  });
}
