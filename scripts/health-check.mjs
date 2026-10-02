#!/usr/bin/env node
/**
 * health-check.mjs — self-host smoke test (SELFHOST-WINDOWS.md).
 *
 * Checks on ONE Windows host, no Docker:
 *   1. API  GET http://localhost:3001/health            -> { ok: true }
 *   2. Web  GET http://localhost:5173/                  -> HTTP 200
 *   3. Storage dirs exist: <STORAGE_PATH>/runs
 *   4. SQLite file exists: DATABASE_URL (file:./dev.db)
 *   5. Playwright chromium installed (npx playwright --version + browser path)
 *
 * Usage: node scripts/health-check.mjs [--api http://localhost:3001] [--web http://localhost:5173]
 * Exit 0 = all healthy, 1 = at least one failure.
 */
import { access, constants } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const apiBase = arg('--api', process.env.API_BASE ?? 'http://localhost:3001').replace(/\/$/, '');
const webBase = arg('--web', process.env.WEB_BASE ?? 'http://localhost:5173').replace(/\/$/, '');
const storageRoot = resolve(process.env.STORAGE_PATH ?? join(process.cwd(), 'storage'));

let failures = 0;
const ok = (name) => console.log(`[health] OK   ${name}`);
const fail = (name, detail) => { failures += 1; console.error(`[health] FAIL ${name} — ${detail}`); };
const fetchDetail = (err) =>
  (err && err.cause && (err.cause.code || err.cause.message)) || (err && err.message) || String(err);

// 1. API health
try {
  const res = await fetch(`${apiBase}/health`);
  const body = await res.json().catch(() => ({}));
  if (res.ok && body.ok) ok(`api ${apiBase}/health`);
  else fail(`api ${apiBase}/health`, `HTTP ${res.status} body=${JSON.stringify(body)}`);
} catch (err) {
  fail(`api ${apiBase}/health`, `${fetchDetail(err)} (server chưa chạy? xem SELFHOST-WINDOWS.md §2)`);
}

// 2. Web
try {
  const res = await fetch(`${webBase}/`, { redirect: 'manual' });
  if (res.status < 500) ok(`web ${webBase}/ (HTTP ${res.status})`);
  else fail(`web ${webBase}/`, `HTTP ${res.status}`);
} catch (err) {
  fail(`web ${webBase}/`, `${fetchDetail(err)} (web chưa chạy? pnpm --filter @playwright-studio/web dev)`);
}

// 3. Storage dirs
for (const dir of [storageRoot, join(storageRoot, 'runs')]) {
  try { await access(dir, constants.R_OK | constants.W_OK); ok(`storage dir ${dir}`); }
  catch { fail(`storage dir ${dir}`, 'missing or not writable — create it and set STORAGE_PATH'); }
}

// 4. SQLite file (DATABASE_URL=file:... → resolve relative to cwd)
{
  const raw = process.env.DATABASE_URL ?? 'file:./dev.db';
  const file = resolve(raw.replace(/^file:/, ''));
  try { await access(file, constants.R_OK); ok(`sqlite ${file}`); }
  catch { fail(`sqlite ${file}`, 'missing — run: pnpm --filter @vv/server exec prisma migrate deploy (or prisma db push)'); }
}

// 5. Playwright chromium (npx là .cmd trên Windows -> cần shell:true)
{
  const sh = process.platform === 'win32';
  const pw = spawnSync('npx', ['playwright', '--version'], { encoding: 'utf8', shell: sh });
  if (pw.status === 0) ok(`playwright ${pw.stdout.trim()}`);
  else fail('playwright --version', 'playwright CLI not found — run: npx playwright install chromium (+ --with-deps on Linux)');
  const ls = spawnSync('npx', ['playwright', 'install', '--dry-run', 'chromium'], { encoding: 'utf8', shell: sh });
  const out = `${ls.stdout ?? ''}${ls.stderr ?? ''}`;
  if (/chromium/i.test(out) || ls.status === 0) ok('playwright chromium browser check');
  else fail('playwright chromium browser', 'chromium not installed — run: npx playwright install chromium');
}

console.log(failures === 0 ? '[health] ALL HEALTHY' : `[health] ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
