/**
 * P2 — analytics / flaky trends. Pure read queries, no migration.
 *
 * REGISTRATION CONTRACT (app.ts is frozen by task scope — maintainer wires):
 *   import { analyticsRoutes } from './routes/analytics.js';
 *   await app.register(analyticsRoutes); // paths are absolute (/api/v1/…), register at ROOT, no prefix
 *
 * - GET /projects/:projectId/analytics/summary  (pass rate, totals, avg
 *   duration, by-browser, N-day window)
 * - GET /projects/:projectId/analytics/flaky    (tests with both passed and
 *   failed in the last N runs + score)
 * - GET /projects/:projectId/analytics/duration (per-day trend, ?testId?)
 * - GET /tests/:id/history                      (recent runs + durations)
 *
 * Secret hygiene: error text is passed through stripServerPaths +
 * redactSecretsText with the project's known secret values (decryptable
 * cells only; undecryptable cells are skipped, never fail the query).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { ApiError } from '../errors.js';
import { parseOrThrow } from '../schemas.js';
import { db } from '../db.js';
import { decryptSecret, redactSecretsText, stripServerPaths } from '../security.js';
import { requireRole } from '../rbac.js';

const TERMINAL = ['passed', 'failed', 'cancelled'] as const;

const windowQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
});

const flakyQuery = z.object({
  runs: z.coerce.number().int().min(5).max(100).optional(),
});

const durationQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
  testId: z.string().min(1).optional(),
});

const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Decryptable secret values for a project (best-effort; never throws). */
export async function projectSecretValues(projectId: string): Promise<string[]> {
  try {
    const rows = await db().variable.findMany({
      where: { projectId, isSecret: true },
      select: { valueEncrypted: true },
    });
    const out: string[] = [];
    for (const r of rows) {
      try {
        const v = decryptSecret(r.valueEncrypted);
        if (v) out.push(v);
      } catch {
        // Key missing / corrupt cell: skip redaction for this value rather
        // than failing the analytics query.
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function scrubErrorText(raw: string | null | undefined, secrets: string[]): string | null {
  if (!raw) return raw ?? null;
  return redactSecretsText(stripServerPaths(raw), secrets);
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  // Summary: totals + pass rate + avg duration + by-browser over N days.
  app.get('/api/v1/projects/:projectId/analytics/summary', { preHandler: requireAuth }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    await requireRole(req, projectId, 'viewer');
    const q = parseOrThrow(windowQuery, req.query);
    const days = q.days ?? 30;
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const project = await db().project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new ApiError('NOT_FOUND', `Project ${projectId} not found`, 404);

    const runs = await db().run.findMany({
      where: { projectId, status: { in: [...TERMINAL] }, finishedAt: { gte: since } },
      select: { status: true, browser: true, durationMs: true, errorSummary: true },
    });
    const passed = runs.filter((r) => r.status === 'passed').length;
    const failed = runs.filter((r) => r.status === 'failed').length;
    const cancelled = runs.filter((r) => r.status === 'cancelled').length;
    const withDuration = runs.filter((r) => r.durationMs !== null) as Array<{ durationMs: number }>;
    const avgDurationMs =
      withDuration.length > 0
        ? Math.round(withDuration.reduce((a, r) => a + (r.durationMs as number), 0) / withDuration.length)
        : null;
    const byBrowser: Record<string, { total: number; passed: number; failed: number; cancelled: number }> = {};
    for (const r of runs) {
      const b = (byBrowser[r.browser] ??= { total: 0, passed: 0, failed: 0, cancelled: 0 });
      b.total += 1;
      if (r.status === 'passed') b.passed += 1;
      else if (r.status === 'failed') b.failed += 1;
      else b.cancelled += 1;
    }
    const secrets = await projectSecretValues(projectId);
    const errorSamples = runs
      .map((r) => r.errorSummary)
      .filter((e): e is string => !!e)
      .slice(0, 5)
      .map((e) => scrubErrorText(e, secrets));
    return {
      window: { days, since: since.toISOString() },
      totals: { total: runs.length, passed, failed, cancelled },
      passRate: passed + failed > 0 ? passed / (passed + failed) : null,
      avgDurationMs,
      byBrowser,
      errorSamples,
    };
  });

  // Flaky: tests with BOTH passed and failed in their last N terminal runs.
  app.get('/api/v1/projects/:projectId/analytics/flaky', { preHandler: requireAuth }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    await requireRole(req, projectId, 'viewer');
    const q = parseOrThrow(flakyQuery, req.query);
    const perTest = q.runs ?? 20;
    const tests = await db().test.findMany({
      where: { projectId },
      select: { id: true, name: true },
      orderBy: { updatedAt: 'desc' },
    });
    const out: Array<{
      testId: string;
      testName: string;
      runs: number;
      passed: number;
      failed: number;
      flakyScore: number;
    }> = [];
    for (const t of tests) {
      const recent = await db().run.findMany({
        where: { testId: t.id, status: { in: ['passed', 'failed'] } },
        orderBy: { finishedAt: 'desc' },
        take: perTest,
        select: { status: true },
      });
      const passed = recent.filter((r) => r.status === 'passed').length;
      const failed = recent.filter((r) => r.status === 'failed').length;
      if (passed > 0 && failed > 0 && recent.length > 0) {
        out.push({
          testId: t.id,
          testName: t.name,
          runs: recent.length,
          passed,
          failed,
          flakyScore: Math.min(passed, failed) / recent.length,
        });
      }
    }
    out.sort((a, b) => b.flakyScore - a.flakyScore);
    return { perTest, flaky: out };
  });

  // Duration trend per day (optional single-test filter).
  app.get('/api/v1/projects/:projectId/analytics/duration', { preHandler: requireAuth }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    await requireRole(req, projectId, 'viewer');
    const q = parseOrThrow(durationQuery, req.query);
    const days = q.days ?? 30;
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    if (q.testId) {
      const t = await db().test.findUnique({ where: { id: q.testId }, select: { projectId: true } });
      if (!t || t.projectId !== projectId) {
        throw new ApiError('VALIDATION_ERROR', `testId ${q.testId} does not belong to project ${projectId}`, 400);
      }
    }
    const runs = await db().run.findMany({
      where: {
        projectId,
        status: { in: [...TERMINAL] },
        finishedAt: { gte: since },
        ...(q.testId ? { testId: q.testId } : {}),
      },
      select: { status: true, durationMs: true, finishedAt: true },
    });
    const byDay = new Map<string, { runs: number; passed: number; failed: number; durations: number[] }>();
    for (const r of runs) {
      if (!r.finishedAt) continue;
      const key = dayKey(r.finishedAt);
      const bucket = byDay.get(key) ?? { runs: 0, passed: 0, failed: 0, durations: [] };
      bucket.runs += 1;
      if (r.status === 'passed') bucket.passed += 1;
      if (r.status === 'failed') bucket.failed += 1;
      if (r.durationMs !== null) bucket.durations.push(r.durationMs);
      byDay.set(key, bucket);
    }
    const trend = [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, b]) => ({
        date,
        runs: b.runs,
        passed: b.passed,
        failed: b.failed,
        avgDurationMs:
          b.durations.length > 0 ? Math.round(b.durations.reduce((x, y) => x + y, 0) / b.durations.length) : null,
      }));
    return { window: { days, since: since.toISOString() }, ...(q.testId ? { testId: q.testId } : {}), trend };
  });

  // Per-test run history (report history view backing).
  app.get('/api/v1/tests/:id/history', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const test = await db().test.findUnique({ where: { id }, select: { id: true, projectId: true, name: true } });
    if (!test) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    await requireRole(req, test.projectId, 'viewer');
    const q = parseOrThrow(historyQuery, req.query);
    const secrets = await projectSecretValues(test.projectId);
    const runs = await db().run.findMany({
      where: { testId: id },
      orderBy: { finishedAt: 'desc' },
      take: q.limit ?? 20,
    });
    return {
      testId: id,
      testName: test.name,
      runs: runs.map((r) => ({
        ...r,
        ...(r.errorSummary ? { errorSummary: scrubErrorText(r.errorSummary, secrets) } : {}),
      })),
    };
  });
}
