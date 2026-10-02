import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const LOGIN_HTML_URL = new URL('../../../fixture/login.html', import.meta.url);

/**
 * Tiny self-contained fixture web app (Day 8-10).
 * Serves apps/fixture/login.html so record/run/E2E never depend on the network:
 *   GET /fixture/login   -> login form (Email/Password/Login -> Dashboard)
 *   GET /fixture/health  -> { ok: true, fixture: 'login' }
 * Mounted WITHOUT the /api/v1 prefix (it is a test target, not Studio API).
 */
export async function fixtureRoutes(app: FastifyInstance): Promise<void> {
  app.get('/fixture/login', async (_req, reply) => {
    let html: string;
    try {
      html = await readFile(fileURLToPath(LOGIN_HTML_URL), 'utf8');
    } catch {
      return reply.code(500).send({
        code: 'FIXTURE_MISSING',
        message: 'Fixture apps/fixture/login.html not found on disk',
      });
    }
    return reply.header('content-type', 'text/html; charset=utf-8').send(html);
  });

  app.get('/fixture/health', async () => ({ ok: true, fixture: 'login' }));
}
