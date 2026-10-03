#!/usr/bin/env node
/**
 * `studio` — Studio CI trigger entry.
 *
 * Calls the server HTTP API directly (ADR-001: never forks the execution
 * engine — Playwright stays server-side). Real I/O wiring only; all logic is
 * in args.ts / api.ts / commands.ts (unit-tested with mocked I/O).
 */
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { main, type ServerSchedulerModule } from './commands.js';

async function loadServerScheduler(serverDist?: string): Promise<ServerSchedulerModule> {
  const candidates: string[] = [];
  if (serverDist) candidates.push(resolve(serverDist, 'scheduler.js'));
  if (process.env.STUDIO_SERVER_DIST) candidates.push(resolve(process.env.STUDIO_SERVER_DIST, 'scheduler.js'));
  // Workspace layout fallback: apps/cli/dist -> apps/server/dist.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(resolve(here, '..', '..', 'server', 'dist', 'scheduler.js'));
  } catch {
    // ignore — fall through to package resolution
  }
  // Linked @vv/server package fallback (needs pnpm install).
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('@vv/server/package.json');
    candidates.push(resolve(dirname(pkgPath), 'dist', 'scheduler.js'));
  } catch {
    // ignore — reported below when nothing loads
  }
  const tried: string[] = [];
  for (const file of candidates) {
    try {
      const mod = (await import(pathToFileURL(file).href)) as Partial<ServerSchedulerModule>;
      if (mod && typeof mod.runDueSchedulesOnce === 'function') {
        return mod as ServerSchedulerModule;
      }
      tried.push(`${file} (no runDueSchedulesOnce export)`);
    } catch (err) {
      tried.push(`${file} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  throw new Error(
    'Could not load the server scheduler. Build it first ' +
      '(pnpm --filter @vv/server build) or set --server-dist/STUDIO_SERVER_DIST. ' +
      `Tried: ${tried.length > 0 ? tried.join('; ') : '(no candidates)'}`,
  );
}

const code = await main(process.argv.slice(2), {
  env: process.env,
  out: (msg) => console.log(msg),
  err: (msg) => console.error(msg),
  writeFile: (path, content) => writeFile(path, content, 'utf8'),
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  now: () => Date.now(),
  loadServerScheduler,
  setEnv: (key, value) => {
    process.env[key] = value;
  },
});
process.exit(code);
