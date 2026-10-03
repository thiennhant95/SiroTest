import type { FastifyInstance } from 'fastify';
import { describePlugin, isPluginsEnabled, loadPluginsFromDir, pluginsDir } from '@playwright-studio/runner';
import { requireAuth, requirePrivileged } from '../auth.js';
import { ApiError } from '../errors.js';

/**
 * P2 plugin routes (metadata only — `execute()` source never leaves the server).
 *
 * Security model (ADR-006, SDK loader.ts):
 * - Listing is authenticated metadata for the docs UI.
 * - (Re)loading executes trusted Dev/Admin code into the server process, so
 *   `POST /plugins/reload` requires a Developer/Admin role AND
 *   `ALLOW_PLUGINS=1` (default OFF). Plugin files must be reviewed before
 *   enabling — there is no JS sandbox by design.
 */
export async function pluginRoutes(app: FastifyInstance): Promise<void> {
  // List loaded plugin manifests (metadata only, safe for browser clients).
  app.get('/plugins', { preHandler: requireAuth }, async () => {
    if (!isPluginsEnabled()) {
      return { enabled: false, dir: pluginsDir(), plugins: [] };
    }
    try {
      const loaded = await loadPluginsFromDir();
      return { enabled: true, dir: loaded.dir, plugins: loaded.plugins.map(describePlugin) };
    } catch (err) {
      throw new ApiError('VALIDATION_ERROR', `Cannot list plugins: ${(err as Error).message}`, 400);
    }
  });

  // Reload plugins from disk (Developer/Admin only, kill-switch enforced).
  app.post('/plugins/reload', { preHandler: requireAuth }, async (req) => {
    requirePrivileged(req);
    if (!isPluginsEnabled()) {
      throw new ApiError(
        'FORBIDDEN',
        `Plugin loading is disabled (set ALLOW_PLUGINS=1 after reviewing ${pluginsDir()})`,
        403,
      );
    }
    try {
      const loaded = await loadPluginsFromDir();
      return { enabled: true, dir: loaded.dir, plugins: loaded.plugins.map(describePlugin) };
    } catch (err) {
      throw new ApiError('VALIDATION_ERROR', `Plugin reload failed: ${(err as Error).message}`, 400);
    }
  });
}
