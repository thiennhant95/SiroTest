import type { FastifyInstance } from 'fastify';
import { RecorderSessionManager, emitStepCaptured, emitSession } from '@vv/recorder';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { ApiError } from '../errors.js';
import { parseOrThrow, recorderStart, locatorTest, assertionAdd } from '../schemas.js';
import { checkAllowedHttpUrl } from '../security.js';
import { db } from '../db.js';

// In-process manager (P0 single instance). Broadcast over WS via app.websocketServer in app.ts.
export const recorderManager = new RecorderSessionManager({
  onEvent: ({ type, session, step }) => {
    const send = (globalThis as { __vvWsBroadcast?: (e: string, p: unknown) => void }).__vvWsBroadcast;
    if (!send) return;
    if (type === 'recorder.stepCaptured' && step) emitStepCaptured(send as never, session, step);
    else emitSession(send as never, type as never, session);
  },
});

export async function recorderRoutes(app: FastifyInstance): Promise<void> {
  app.post('/tests/:id/recorder/start', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await requireProjectAccess(req);
    const body = parseOrThrow(recorderStart, req.body);
    const test = await db().test.findUnique({ where: { id } });
    if (!test) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    // SSRF guard: only public http(s) targets may drive a privileged browser.
    const urlCheck = checkAllowedHttpUrl(body.baseUrl ?? null);
    if (!urlCheck.ok) {
      throw new ApiError('VALIDATION_ERROR', `baseUrl rejected: ${urlCheck.reason}`, 400);
    }
    try {
      const session = recorderManager.start({
        userId: req.user!.id, testId: id, projectId: test.projectId,
        includeHover: body.includeHover,
      });
      // TODO: launch headed browser + inject bridge script for baseUrl ?? project.baseUrl
      return reply.code(201).send({ sessionId: session.sessionId, status: session.status, testId: id });
    } catch (e) {
      throw e; // CONFLICT_RECORDER_ACTIVE maps to 409 in error handler
    }
  });

  app.post('/recorder/:sessionId/pause', { preHandler: requireAuth }, async (req) => {
    const { sessionId } = req.params as { sessionId: string };
    requireSessionOwner(sessionId, req.user!.id);
    return recorderManager.pause(sessionId);
  });

  app.post('/recorder/:sessionId/resume', { preHandler: requireAuth }, async (req) => {
    const { sessionId } = req.params as { sessionId: string };
    requireSessionOwner(sessionId, req.user!.id);
    return recorderManager.resume(sessionId);
  });

  app.post('/recorder/:sessionId/stop', { preHandler: requireAuth }, async (req) => {
    const { sessionId } = req.params as { sessionId: string };
    requireSessionOwner(sessionId, req.user!.id);
    const s = recorderManager.getBySessionId(sessionId);
    if (!s) throw new ApiError('NOT_FOUND', `Recorder session ${sessionId} not found`, 404);
    const stopped = recorderManager.stop(sessionId);
    // Persist draft steps into definition_json (append). Same versioning rule
    // as PATCH /tests/:id (versioning.md): every meaningful save mints a new
    // immutable test_versions row — recorder stops must not bypass history.
    const test = await db().test.findUnique({
      where: { id: stopped.testId },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });
    if (test && stopped.draftSteps.length > 0) {
      const def = JSON.parse(test.definitionJson) as { steps: unknown[] };
      const appended = [...def.steps, ...stopped.draftSteps.map(toDefinitionStep)];
      const nextJson = JSON.stringify({ ...def, steps: appended });
      const next = (test.versions[0]?.versionNumber ?? 0) + 1;
      await db().test.update({ where: { id: stopped.testId }, data: { definitionJson: nextJson } });
      await db().testVersion.create({
        data: {
          testId: stopped.testId, versionNumber: next, definitionJson: nextJson,
          createdBy: req.user!.id,
          changeMessage: `Recorded ${stopped.draftSteps.length} step(s) via recorder`,
        },
      });
    }
    return { sessionId, status: stopped.status, draftCount: stopped.draftSteps.length };
  });

  // Browser death / unexpected close (recorder-spec.md Recovery):
  // keep already-captured draft steps, mark session `interrupted`.
  // The browser supervisor (or the client that detects the close) calls
  // this; the normal stop flow is untouched. Draft stays retrievable via
  // GET below so the user can resume/re-record without losing work.
  app.post('/recorder/:sessionId/interrupt', { preHandler: requireAuth }, async (req) => {
    const { sessionId } = req.params as { sessionId: string };
    const reason = ((req.body as { reason?: unknown } | undefined)?.reason as string | undefined) ?? 'browser-closed';
    const s = recorderManager.getBySessionId(sessionId);
    if (!s) throw new ApiError('NOT_FOUND', `Recorder session ${sessionId} not found`, 404);
    const interrupted = recorderManager.markInterrupted(sessionId, String(reason).slice(0, 200));
    return { sessionId, status: interrupted.status, reason: interrupted.interruptReason, draftCount: interrupted.draftSteps.length };
  });

  app.get('/recorder/:sessionId', { preHandler: requireAuth }, async (req) => {
    const { sessionId } = req.params as { sessionId: string };
    const s = recorderManager.getBySessionId(sessionId);
    if (!s) throw new ApiError('NOT_FOUND', `Recorder session ${sessionId} not found`, 404);
    return s;
  });
  // Pick locator mode (locator picker protocol — Day 3 gate)
  app.post('/recorder/:sessionId/locator/pick', { preHandler: requireAuth }, async (req) => {
    const { sessionId } = req.params as { sessionId: string };
    requireSessionOwner(sessionId, req.user!.id);
    return recorderManager.setPickMode(sessionId, 'locator');
  });

  // Test a locator candidate against the live browser -> 0/1/N + preview
  // (05-locator/locator-engine.md: "Test Locator"). A step cannot be saved
  // healthy when matches == 0; N matches warn unless the step allows multiple.
  app.post('/recorder/:sessionId/locator/test', { preHandler: requireAuth }, async (req) => {
    const { sessionId } = req.params as { sessionId: string };
    requireSessionOwner(sessionId, req.user!.id);
    const body = parseOrThrow(locatorTest, req.body);
    const s = recorderManager.getBySessionId(sessionId);
    if (!s) throw new ApiError('NOT_FOUND', `Recorder session ${sessionId} not found`, 404);
    // P0 honesty gate: RecorderSession carries NO live browser page reference
    // (see @vv/recorder types.ts + sessionManager.ts — no playwright import,
    // start() only creates metadata; browser launch is still a TODO above).
    // With no live page there is nothing truthful to count, so fail loudly
    // instead of returning a fabricated match count.
    // Future (live page attached): resolve `body.candidate` via Playwright
    // `locator.count()` + highlight matched element(s) via page.evaluate,
    // mapping candidate -> expression with locator-engine toExpression.
    void body;
    throw new ApiError(
      'RECORDER_NO_LIVE_BROWSER',
      `Recorder session ${sessionId} has no live browser attached: cannot test locator. Start/attach the recorder browser, then test again.`,
      503,
      { sessionId, preview: null },
    );
  });

  // Pick assertion mode + add assertion step
  app.post('/recorder/:sessionId/assertion/pick', { preHandler: requireAuth }, async (req) => {
    const { sessionId } = req.params as { sessionId: string };
    requireSessionOwner(sessionId, req.user!.id);
    return recorderManager.setPickMode(sessionId, 'assertion');
  });

  app.post('/recorder/:sessionId/assertion', { preHandler: requireAuth }, async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    requireSessionOwner(sessionId, req.user!.id);
    const body = parseOrThrow(assertionAdd, req.body);
    const step = recorderManager.addAssertion(sessionId, {
      type: body.type, url: '', locator: body.target, value: body.expected,
    } as never);
    return reply.code(201).send(step);
  });
}

function toDefinitionStep(s: { id: string; type: string; locator?: unknown; value?: string; key?: string; url: string }): Record<string, unknown> {
  // Minimal TestDefinition step; locator filled by locator-engine (primary+alternatives).
  return { id: s.id, type: s.type, enabled: true, target: s.locator ?? null, value: s.value, key: s.key, url: s.url };
}

/** A user may only drive their own recorder session (cross-user hijack guard). */
function requireSessionOwner(sessionId: string, userId: string): void {
  const s = recorderManager.getBySessionId(sessionId);
  if (!s) throw new ApiError('NOT_FOUND', `Recorder session ${sessionId} not found`, 404);
  if (s.userId !== userId) throw new ApiError('FORBIDDEN', 'Recorder session belongs to another user', 403);
}
