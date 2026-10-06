import type { FastifyInstance } from 'fastify';
import {
  RecorderSessionManager,
  emitStepCaptured,
  emitSession,
  launchRecorderBrowser,
  type BridgeEvent,
  type RecorderBrowser,
  type ResolvedLocator,
} from '@vv/recorder';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { requireProjectWrite } from '../rbac.js';
import { ApiError } from '../errors.js';
import { parseOrThrow, recorderStart, locatorTest, assertionAdd } from '../schemas.js';
import { checkAllowedHttpUrl } from '../security.js';
import { db } from '../db.js';

// In-process manager (P0 single instance). Broadcast over WS via app.websocketServer in app.ts.
export const recorderManager = new RecorderSessionManager({
  onEvent: ({ type, session, step, data }) => {
    const send = (globalThis as { __vvWsBroadcast?: (e: string, p: unknown) => void }).__vvWsBroadcast;
    if (!send) return;
    if (type === 'recorder.stepCaptured' && step) emitStepCaptured(send as never, session, step);
    else emitSession(send as never, type as never, session, (data ?? {}) as Record<string, unknown>);
  },
});

/**
 * Live-browser event pipeline: bridge event -> (pick mode?) -> locator
 * resolution at the event point -> ingest with resolved locator.
 * Every Playwright call is guarded: resolution failure degrades to a
 * locator-less step, never a dropped session.
 */
async function handleLiveEvent(
  sessionId: string,
  browser: RecorderBrowser,
  evt: BridgeEvent,
): Promise<void> {
  const session = recorderManager.getBySessionId(sessionId);
  if (!session) return;
  try {
    if (session.pickMode !== 'off' && (evt.kind === 'click' || evt.kind === 'dblclick')) {
      const resolved = await browser.resolveFromEvent(evt);
      if (resolved) {
        recorderManager.completePick(sessionId, {
          candidate: resolved.primary,
          alternatives: resolved.alternatives,
        });
      } else {
        recorderManager.completePick(sessionId, { candidate: null, preview: 'no element at pick point' });
      }
      return;
    }
    let locator: { primary: unknown; alternatives?: unknown[] } | undefined;
    if (evt.kind === 'click' || evt.kind === 'dblclick' || evt.kind === 'input' || evt.kind === 'change' || evt.kind === 'select' || evt.kind === 'check' || evt.kind === 'hover') {
      const resolved = await browser.resolveFromEvent(evt);
      if (resolved) locator = { primary: resolved.primary, alternatives: resolved.alternatives };
    }
    recorderManager.ingestResolved(sessionId, evt, locator);
  } catch {
    // Degrade to a plain ingest — the session must survive host errors.
    try {
      recorderManager.ingest(sessionId, evt);
    } catch {
      // Session gone (stopped concurrently) — nothing to do.
    }
  }
}

function safeInterrupt(sessionId: string, reason: string): void {
  try {
    const s = recorderManager.getBySessionId(sessionId);
    // Skip terminal sessions: stop() already settled them, and an
    // already-interrupted session must not re-emit (closeBrowser triggers
    // onClose after an explicit interrupt — that echo is noise, not news).
    if (!s || s.status === 'stopped' || s.status === 'interrupted') return;
    recorderManager.markInterrupted(sessionId, reason);
  } catch {
    // Session already gone — nothing to do.
  }
}

export async function recorderRoutes(app: FastifyInstance): Promise<void> {
  app.post('/tests/:id/recorder/start', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await requireProjectWrite(req);
    const body = parseOrThrow(recorderStart, req.body);
    const test = await db().test.findUnique({ where: { id } });
    if (!test) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    const project = await db().project.findUnique({ where: { id: test.projectId } });
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
      // Live browser (04-recorder): launch Chromium for real human
      // interaction, with the bridge injected on every page. Headed launch
      // failure falls back to headless once; total failure still starts the
      // session (WS-ingested events keep working) but flags liveBrowser false.
      const wantHeaded = body.headed ?? true;
      let liveBrowser = false;
      let launchedHeaded: boolean | undefined;
      const base = body.baseUrl ?? project?.baseUrl ?? testBaseUrl(test);
      if (base !== undefined && base !== body.baseUrl) {
        // Non-request origins (project/definition) get the same SSRF gate.
        const baseCheck = checkAllowedHttpUrl(base);
        if (!baseCheck.ok) {
          throw new ApiError('VALIDATION_ERROR', `baseUrl rejected: ${baseCheck.reason}`, 400);
        }
      }
      for (const headed of wantHeaded ? [true, false] : [false]) {
        try {
          const hb = await launchRecorderBrowser({
            headed,
            ...(base ? { baseUrl: base } : {}),
            includeHover: body.includeHover,
            events: {
              onBridgeEvent: (evt) => {
                void handleLiveEvent(session.sessionId, hb, evt);
              },
              onClose: (reason) => safeInterrupt(session.sessionId, reason),
            },
          });
          recorderManager.attachBrowser(session.sessionId, hb);
          liveBrowser = true;
          launchedHeaded = headed;
          break;
        } catch {
          // Try the next mode; session survives without a live browser.
        }
      }
      return reply.code(201).send({
        sessionId: session.sessionId, status: session.status, testId: id,
        liveBrowser,
        ...(launchedHeaded !== undefined ? { headed: launchedHeaded } : {}),
      });
    } catch (e) {
      throw e; // CONFLICT_RECORDER_ACTIVE maps to 409 in error handler
    }
  });

/** Best-effort baseUrl from the stored definition (SSRF-checked by callers). */
function testBaseUrl(test: { definitionJson: string }): string | undefined {
  try {
    const def = JSON.parse(test.definitionJson) as { baseUrl?: unknown };
    return typeof def.baseUrl === 'string' && def.baseUrl.length > 0 ? def.baseUrl : undefined;
  } catch {
    return undefined;
  }
}

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
    // Closing the live browser releases the headed window/process tree.
    // stop() already flushed the normalizer, so drafts are safe first.
    await recorderManager.closeBrowser(sessionId, 'session-stopped');
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
    requireSessionOwner(sessionId, req.user!.id);
    const s = recorderManager.getBySessionId(sessionId);
    if (!s) throw new ApiError('NOT_FOUND', `Recorder session ${sessionId} not found`, 404);
    // Live UIs render flushed drafts + the trailing pending step still held
    // by the normalizer (persistence only ever stores flushed steps).
    return { ...s, liveBrowser: recorderManager.hasLiveBrowser(sessionId), pendingSteps: recorderManager.pendingSteps(sessionId) };
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
    const browser = recorderManager.getBrowser(sessionId);
    if (!browser) {
      // No live page to count against: fail loudly instead of fabricating
      // a match count (honesty gate).
      throw new ApiError(
        'RECORDER_NO_LIVE_BROWSER',
        `Recorder session ${sessionId} has no live browser attached: cannot test locator. Start/attach the recorder browser, then test again.`,
        503,
        { sessionId, preview: null },
      );
    }
    const candidate = body.candidate as Parameters<RecorderBrowser['testLocator']>[0];
    const verdict = await browser.testLocator(candidate);
    return {
      sessionId,
      matches: verdict.matchCount,
      matchCount: verdict.matchCount,
      status: verdict.status,
      canSave: verdict.canSave,
      ...(verdict.warning !== undefined ? { warning: verdict.warning } : {}),
      message: verdict.message,
      preview: verdict.preview,
      healthy: verdict.status === 'unique',
    };
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
