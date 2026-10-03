import { createRequire } from 'node:module';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginRegistry, StudioPlugin } from './types.js';
import { PluginValidationError, validatePluginManifest } from './validate.js';

export class PluginLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginLoadError';
  }
}

/**
 * Plugins are disabled unless explicitly opted in. `ALLOW_PLUGINS=1` is the
 * kill-switch (default OFF); additionally only Developer/Admin roles may
 * enable or reload plugins (enforced in the server route, ADR-006). The
 * loader itself refuses to touch the filesystem when disabled.
 */
export function isPluginsEnabled(): boolean {
  return process.env.ALLOW_PLUGINS === '1';
}

/** Directory plugins load from (`PLUGINS_DIR`, default `<cwd>/plugins`). */
export function pluginsDir(): string {
  const raw = process.env.PLUGINS_DIR;
  return raw && raw.length > 0 ? raw : join(process.cwd(), 'plugins');
}

export interface LoadedPlugins {
  enabled: boolean;
  dir: string;
  plugins: StudioPlugin[];
  /** step type -> owner (fail-fast map used by the runner at compile time). */
  registry: PluginRegistry;
  /** Absolute entry files (runner copies these into the isolated workdir). */
  files: string[];
}

/**
 * Load every plugin entry (`.js`/`.cjs`/`.mjs`) from a directory.
 *
 * Security model (documented, no sandbox):
 * - Callers MUST gate on `isPluginsEnabled()` — this function throws
 *   `PLUGIN_DISABLED` otherwise (defense in depth; the server route and the
 *   runner both check before calling).
 * - Entry files are trusted Dev/Admin code: they are `require()`d into the
 *   worker process with full Node power. Review before enabling.
 * - Only basenames inside the directory are loaded (no traversal: directory
 *   entries can never escape it); subdirectories are ignored (single-file
 *   plugins, or a folder with an `index.js` — loaded as one entry).
 * - Duplicate step types across plugins fail explicitly (no shadowing).
 */
export async function loadPluginsFromDir(dir?: string): Promise<LoadedPlugins> {
  const target = dir ?? pluginsDir();
  if (!isPluginsEnabled()) {
    throw new PluginLoadError(
      `PLUGIN_DISABLED: plugin loading is disabled (set ALLOW_PLUGINS=1 and have a Developer/Admin review the plugins in ${target} first)`,
    );
  }
  let entries: string[];
  try {
    entries = await readdir(target);
  } catch (err) {
    throw new PluginLoadError(
      `PLUGIN_DIR_UNREADABLE: cannot read plugins directory ${target}: ${(err as Error).message}`,
    );
  }
  const registry: PluginRegistry = new Map();
  const plugins: StudioPlugin[] = [];
  const files: string[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith('.')) continue;
    if (!/\.(cjs|js|mjs)$/.test(entry)) continue;
    // Basename only — readdir entries cannot traverse, and we never follow
    // caller-supplied paths here.
    const abs = join(target, entry);
    const manifest = await loadEntry(abs);
    validatePluginManifest(manifest);
    const plugin = manifest as StudioPlugin;
    for (const step of plugin.steps) {
      const clash = registry.get(step.type);
      if (clash) {
        throw new PluginLoadError(
          `PLUGIN_TYPE_CONFLICT: step type "${step.type}" is declared by both "${clash.plugin.name}" and "${plugin.name}" (from ${entry}) — step types must be globally unique`,
        );
      }
      registry.set(step.type, { plugin, step });
    }
    plugins.push(plugin);
    files.push(abs);
  }
  return { enabled: true, dir: target, plugins, registry, files };
}

async function loadEntry(abs: string): Promise<unknown> {
  // Bust the require cache so POST /plugins/reload picks up edits without a
  // server restart. ESM entries are imported fresh via a cache-busting query.
  try {
    const req = createRequire(abs);
    try {
      delete req.cache[abs];
    } catch {
      // not cached yet — ignore
    }
    const mod = req(abs) as { __esModule?: boolean; default?: unknown } | StudioPlugin;
    const candidate =
      mod && typeof mod === 'object' && 'default' in (mod as Record<string, unknown>)
        ? ((mod as { default?: unknown }).default ?? mod)
        : mod;
    return candidate;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ERR_REQUIRE_ESM') {
      const fresh = `${pathToFileURL(abs).href}?vv=${Date.now()}`;
      const mod = (await import(fresh)) as { default?: unknown };
      return mod.default ?? mod;
    }
    if (err instanceof PluginValidationError) throw err;
    throw new PluginLoadError(
      `PLUGIN_ENTRY_INVALID: ${abs} failed to load: ${(err as Error).message}`,
    );
  }
}

/** Manifest metadata safe to expose to browser clients (no function source). */
export function describePlugin(plugin: StudioPlugin): {
  name: string;
  version: string;
  description?: string;
  steps: Array<{ type: string; description?: string; schema?: StudioPlugin['steps'][number]['schema'] }>;
} {
  return {
    name: plugin.name,
    version: plugin.version,
    ...(plugin.description !== undefined ? { description: plugin.description } : {}),
    steps: plugin.steps.map((s) => ({
      type: s.type,
      ...(s.description !== undefined ? { description: s.description } : {}),
      ...(s.schema !== undefined ? { schema: s.schema } : {}),
    })),
  };
}
