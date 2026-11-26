#!/usr/bin/env node
/**
 * Import the starter examples into a running SiroTest server.
 *
 * Each JSON file in examples/starters becomes a project + one test. Existing
 * projects with the same name are reused (the test is added to them), so the
 * script is safe to re-run.
 *
 * Usage:
 *   $env:STUDIO_API_URL='http://127.0.0.1:3001/api/v1'
 *   $env:STUDIO_TOKEN='<session token or dev user id>'
 *   node scripts/import-examples.mjs
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'examples', 'starters');
const API = (process.env.STUDIO_API_URL ?? 'http://127.0.0.1:3001/api/v1').replace(/\/$/, '');
const TOKEN = process.env.STUDIO_TOKEN ?? '';
const WEB = (process.env.STUDIO_WEB_URL ?? API.replace(/\/api\/v1$/, '').replace(/:3001$/, ':5173')).replace(/\/$/, '');
if (!TOKEN) {
  console.error('STUDIO_TOKEN is required (session token, or a dev user id like tester-1)');
  process.exit(2);
}
const H = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return json;
}

const files = (await readdir(DIR)).filter((f) => f.endsWith('.json')).sort();
if (files.length === 0) {
  console.error(`no starter files in ${DIR}`);
  process.exit(2);
}

const projects = await call('GET', '/projects');
for (const file of files) {
  const spec = JSON.parse(await readFile(join(DIR, file), 'utf8'));
  const baseUrl = spec.baseUrl;
  let project = projects.find((p) => p.name === spec.name);
  if (!project) {
    project = await call('POST', '/projects', { name: spec.name, description: `Starter example (${file})`, baseUrl });
    projects.push(project);
    console.log(`project: ${spec.name} (${project.id})`);
  } else {
    console.log(`project: ${spec.name} (exists)`);
  }

  const envs = await call('GET', `/projects/${project.id}/environments`);
  if (envs.length === 0) {
    await call('POST', `/projects/${project.id}/environments`, { name: 'default', baseUrl, isDefault: true });
  }

  const tests = await call('GET', `/projects/${project.id}/tests`);
  if (tests.some((t) => t.name === spec.name)) {
    console.log(`  test: ${spec.name} (exists, skipped)`);
    continue;
  }
  const definitionJson = { schemaVersion: '1.0', id: '', projectId: '', name: spec.name, browser: 'chromium', baseUrl, steps: spec.steps };
  const created = await call('POST', `/projects/${project.id}/tests`, { name: spec.name, browser: 'chromium', definitionJson });
  console.log(`  test: ${spec.name} (${created.id})`);
  console.log(`  open: ${WEB}/tests/${created.id}`);
}
console.log('done');
