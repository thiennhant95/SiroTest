#!/usr/bin/env node
/**
 * cleanup-artifacts.mjs — artifact retention (artifacts-reporting.md).
 *
 * Deletes storage/runs/<run-id>/ dirs older than ARTIFACT_RETENTION_DAYS
 * (default 30, spec range 14-30). Keeps result.json safety: only whole
 * run dirs are removed, never partial files.
 *
 * Usage:
 *   node scripts/cleanup-artifacts.mjs [--dry-run] [--retention-days N] [--storage <path>]
 *   pnpm cleanup            # real run (ARTIFACT_RETENTION_DAYS from env, default 30)
 *   pnpm cleanup:dry         # preview only
 *
 * Env: STORAGE_PATH (default ./storage), ARTIFACT_RETENTION_DAYS (default 30).
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dryRun =
  process.argv.includes('--dry-run') || process.argv.includes('--dry') || process.env.DRY_RUN === '1';
const retentionDays = Math.max(
  1,
  Math.floor(Number(arg('--retention-days', process.env.ARTIFACT_RETENTION_DAYS ?? '30')) || 30),
);
const storageRoot = resolve(arg('--storage', process.env.STORAGE_PATH ?? join(process.cwd(), 'storage')));
const runsDir = join(storageRoot, 'runs');
const cutoffMs = retentionDays * 24 * 60 * 60 * 1000;
const now = Date.now();

let entries;
try {
  entries = await readdir(runsDir);
} catch {
  console.log(`[cleanup] nothing to do — runs dir missing: ${runsDir}`);
  process.exit(0);
}

let scanned = 0, expired = 0, removed = 0, bytes = 0;
const doomed = [];
for (const name of entries) {
  if (name.startsWith('.')) continue;
  const abs = join(runsDir, name);
  let st;
  try {
    st = await stat(abs);
  } catch { continue; }
  if (!st.isDirectory()) continue;
  scanned += 1;
  const ageDays = (now - st.mtimeMs) / (24 * 60 * 60 * 1000);
  if (now - st.mtimeMs > cutoffMs) {
    expired += 1;
    doomed.push({ name, ageDays });
  }
}

async function dirSize(abs) {
  let total = 0;
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else { try { total += (await stat(p)).size; } catch { /* gone */ } }
    }
  };
  try { await walk(abs); } catch { /* gone */ }
  return total;
}

for (const d of doomed) {
  const abs = join(runsDir, d.name);
  const size = await dirSize(abs);
  if (dryRun) {
    console.log(`[cleanup:dry] would remove runs/${d.name} (age ${d.ageDays.toFixed(1)}d > ${retentionDays}d, ~${size} bytes)`);
  } else {
    try {
      await rm(abs, { recursive: true, force: true });
      console.log(`[cleanup] removed runs/${d.name} (age ${d.ageDays.toFixed(1)}d, ~${size} bytes)`);
      removed += 1;
      bytes += size;
    } catch (err) {
      console.error(`[cleanup] FAILED runs/${d.name}: ${err.message}`);
    }
  }
}

console.log(
  dryRun
    ? `[cleanup:dry] scanned=${scanned} expired=${expired} retention=${retentionDays}d storage=${storageRoot}`
    : `[cleanup] scanned=${scanned} expired=${expired} removed=${removed} freed~${bytes}B retention=${retentionDays}d storage=${storageRoot}`,
);
