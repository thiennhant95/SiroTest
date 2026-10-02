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
import { runRoutes } from './routes/runs.js';
import { compilerRoutes } from './routes/compiler.js';
import { fixtureRoutes } from './routes/fixture.js';

export async function buildApp() {
  // Upload/artifact size limit: reject oversized JSON bodies before parsing.
  const app = Fastify({ logger: true, bodyLimit: JSON_BODY_LIMIT_BYTES });
  await app.register(websocket);

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
      await v1.register(compilerRoutes);
    },
    { prefix: '/api/v1' },
  );

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

  app.get('/ws', { websocket: true }, (socket, req) => {
    const user = authenticateWsToken(req.query);
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
      try {
        const msg = JSON.parse(String(raw)) as { sessionId?: string; evt?: unknown };
        if (msg.sessionId && msg.evt) {
          const session = recorderManager.getBySessionId(msg.sessionId);
          if (!session) return;
          if (session.userId !== peer.userId) {
            peer.send(JSON.stringify({ event: 'error', payload: { code: 'FORBIDDEN', message: 'Recorder session belongs to another user' } }));
            return;
          }
          recorderManager.ingest(msg.sessionId, msg.evt);
        }
      } catch { /* ignore malformed frames */ }
    });
    socket.on('close', () => { peers.delete(peer); });
  });

  return app;
}

const port = Number(process.env.PORT ?? 3001);
if (process.env.SKIP_LISTEN !== '1') {
  buildApp()
    .then((app) => app.listen({ port, host: '0.0.0.0' }))
    .catch((err) => { console.error(err); process.exit(1); });
}
