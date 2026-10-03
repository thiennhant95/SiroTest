import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { toErrorBody } from './errors.js';
import { authenticateWsToken } from './auth.js';
import { JSON_BODY_LIMIT_BYTES } from './security.js';
import { projectRoutes } from './routes/projects.js';
import { testRoutes } from './routes/tests.js';
import { environmentRoutes } from './routes/environments.js';
import { variableRoutes } from './routes/variables.js';
import { recorderRoutes, recorderManager } from './routes/recorder.js';
import { resolveEventLocator } from '@vv/recorder';
import { runRoutes } from './routes/runs.js';
import { datasetRoutes } from './routes/datasets.js';
import { suiteRoutes } from './routes/suites.js';
import { actionRoutes } from './routes/actions.js';
import { profileRoutes } from './routes/profiles.js';
import { fileRoutes } from './routes/files.js';
import { scheduleRoutes } from './routes/schedules.js';
import { transferRoutes } from './routes/transfer.js';
import { specImportRoutes } from './routes/specimport.js';
import { compilerRoutes } from './routes/compiler.js';
import { healingRoutes } from './routes/healing.js';
import { suggestionRoutes } from './routes/suggestions.js';
import { aiRoutes } from './routes/ai.js';
import { visualRoutes } from './routes/visual.js';
import { pluginRoutes } from './routes/plugins.js';
import { fixtureRoutes } from './routes/fixture.js';
import { workerRoutes } from './routes/workers.js';
import { analyticsRoutes } from './routes/analytics.js';
import { auditRoutes } from './routes/audit.js';

export async function buildApp() {
  // Upload/artifact size limit: reject oversized JSON bodies before parsing.
  const app = Fastify({ logger: true, bodyLimit: JSON_BODY_LIMIT_BYTES });
  await app.register(websocket);

  // CORS for split deployments (web static host ≠ API host). Same-origin
  // setups (vite proxy in dev, single host in prod) need nothing.
  // CORS_ALLOWED_ORIGINS="https://studio.example.com,https://..." — exact
  // match only, no wildcards; unset = no cross-origin access. Credentials
  // are never needed (Bearer/header auth, no cookies).
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter((s) => s.length > 0);
  if (allowedOrigins.length > 0) {
    app.addHook('onRequest', async (req, reply) => {
      const origin = req.headers.origin;
      if (origin && allowedOrigins.includes(origin)) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Vary', 'Origin');
        reply.header('Access-Control-Allow-Headers', 'content-type, authorization, x-user-id');
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      }
      if (req.method === 'OPTIONS') {
        return reply.code(origin && allowedOrigins.includes(origin) ? 204 : 403).send();
      }
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    const { statusCode, body } = toErrorBody(err);
    return reply.code(statusCode).send(body);
  });

  app.get('/health', async () => ({ ok: true }));

  // Tiny fixture target app (no /api/v1 prefix — it is a test target, not API).
  await app.register(fixtureRoutes);

  await app.register(
    async (v1) => {
      await v1.register(projectRoutes);
      await v1.register(testRoutes);
      await v1.register(environmentRoutes);
      await v1.register(variableRoutes);
      await v1.register(recorderRoutes);
      await v1.register(runRoutes);
      await v1.register(datasetRoutes);
      await v1.register(suiteRoutes);
      await v1.register(actionRoutes);
      await v1.register(profileRoutes);
      await v1.register(fileRoutes);
      await v1.register(scheduleRoutes);
      await v1.register(transferRoutes);
      await v1.register(specImportRoutes);
      await v1.register(compilerRoutes);
      await v1.register(healingRoutes);
      await v1.register(suggestionRoutes);
      await v1.register(aiRoutes);
      await v1.register(visualRoutes);
      await v1.register(pluginRoutes);
    },
    { prefix: '/api/v1' },
  );
  // P2 ops routes declare absolute /api/v1/... paths (see routes/workers.ts,
  // analytics.ts, audit.ts) so they register at root without a prefix.
  await app.register(workerRoutes);
  await app.register(analyticsRoutes);
  await app.register(auditRoutes);

  // WS channel: authenticated clients subscribe with
  // ?token=<bearer-or-user-id>&runId=… and/or &sessionId=….
  // The server broadcasts recorder.* + run.* events; DB remains authoritative
  // on reconnect. Events are fanned out ONLY to peers subscribed to the same
  // run/session (or the event owner), never to every connected socket.
  interface Peer {
    send: (m: string) => void;
    userId: string;
    runId?: string;
    sessionId?: string;
  }
  const peers = new Set<Peer>();
  (globalThis as { __vvWsBroadcast?: unknown }).__vvWsBroadcast = (event: string, payload: unknown) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    const msg = JSON.stringify({ event, payload });
    for (const peer of peers) {
      try {
        // Scoped fan-out: a filtered peer only receives its own run/session.
        // Unfiltered peers (no runId/sessionId) receive run.* addressed to them
        // only when the payload carries no run/session scope.
        if (peer.runId && p['runId'] !== peer.runId) continue;
        if (peer.sessionId && p['sessionId'] !== peer.sessionId) continue;
        peer.send(msg);
      } catch { /* ignore dead peers */ }
    }
  };

  app.get('/ws', { websocket: true }, (socket, req) => {    const user = authenticateWsToken(req.query);
    if (!user) {
      // No cookie auth exists, so WS cannot rely on ambient credentials:
      // close unauthenticated handshakes instead of leaking events.
      socket.close(4401, 'Missing WS token (?token=)');
      return;
    }
    const q = (req.query ?? {}) as Record<string, unknown>;
    const peer: Peer = {
      send: (m: string) => socket.send(m),
      userId: user.id,
      ...(typeof q['runId'] === 'string' ? { runId: q['runId'] } : {}),
      ...(typeof q['sessionId'] === 'string' ? { sessionId: q['sessionId'] } : {}),
    };
    peers.add(peer);
    socket.on('message', (raw: Buffer) => {
      // Bridge ingest: { sessionId, evt } — evt is minimal BridgeEvent metadata.
      // Only the session owner may ingest into it (cross-user hijack guard).
      // Locator resolution matches the live-browser path (resolveEventLocator):
      // a session WITH a live browser gets verified candidates; externally
      // driven pages get an unverified rank from event-time metadata.
      try {
        const msg = JSON.parse(String(raw)) as { sessionId?: string; evt?: unknown };
        if (msg.sessionId && msg.evt) {
          const session = recorderManager.getBySessionId(msg.sessionId);
          if (!session) return;
          if (session.userId !== peer.userId) {
            peer.send(JSON.stringify({ event: 'error', payload: { code: 'FORBIDDEN', message: 'Recorder session belongs to another user' } }));
            return;
          }
          void (async () => {
            try {
              const browser = recorderManager.getBrowser(msg.sessionId as string);
              const locator = await resolveEventLocator(
                browser?.page,
                msg.evt as Parameters<typeof resolveEventLocator>[1],
              );
              recorderManager.ingestResolved(msg.sessionId as string, msg.evt, locator);
            } catch {
              try {
                recorderManager.ingest(msg.sessionId as string, msg.evt);
              } catch {
                // Session gone concurrently — nothing to do.
              }
            }
          })();
        }
      } catch { /* ignore malformed frames */ }
    });
    socket.on('close', () => { peers.delete(peer); });
  });

  return app;
}

// NOTE: this module intentionally has NO bottom listen block. The single
// canonical entry is src/index.ts (listen + boot recovery + scheduler).
// Keeping listen logic here would double-listen whenever index.js imports
// buildApp (EADDRINUSE crash). Dev: `tsx watch src/index.ts`,
// prod: `node dist/index.js`, tests/e2e import buildApp() directly.
