/**
 * Integration: P2 visual baselines API + plugin routes (no browser needed).
 *
 * A standalone Fastify instance registers ONLY the new P2 routes
 * (visualRoutes + pluginRoutes) — app.ts is untouched by this change, so the
 * registration contract (2 lines) is verified by hand, not by importing it.
 * Real SQLite integration DB + real storage dir; real PNG bytes.
 *
 * Covers: baselines list (metadata only, no paths), promote (artifact ->
 * baseline with PNG validation), image serve, delete, artifact image serve
 * (+ auth/project membership), validation paths (400/401/403/404), and the
 * plugin list/reload gates.
 *
 * Run: npx tsx --test tests/integration/visual-baselines.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import { ensureIntegrationDb, injectJson, TEST_USER_ID, repoRoot } from './helpers.js';
import { encodePngImage } from '../../apps/runner/src/visual-compare.js';

// `fastify` is a dependency of apps/server only (pnpm strict) — resolve it
// through the server package instead of importing it from tests/.
const serverRequire = createRequire(join(repoRoot(), 'apps/server', 'package.json'));
const Fastify = (serverRequire('fastify') as { default: unknown }).default as () => FastifyInstance;

process.env.SKIP_LISTEN = '1';
const { visualRoutes } = await import('../../apps/server/src/routes/visual.js');
const { pluginRoutes } = await import('../../apps/server/src/routes/plugins.js');
const { db } = await import('../../apps/server/src/db.js');

let app: FastifyInstance;
/** Real HTTP base (ephemeral port): light-my-request decodes bodies as UTF-8,
 * so binary image bytes are verified through fetch instead of app.inject. */
let httpBase = '';
let projectId: string;
let envId: string;
let testId: string;
let runId: string;
let artifactId: string;

function solidPng(w: number, h: number, r: number, g: number, b: number): Buffer {
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
  }
  return encodePngImage(w, h, rgba);
}

function strangerHeaders(): Record<string, string> {
  return { 'x-user-id': 'u_visual_stranger', 'content-type': 'application/json' };
}

before(async () => {
  process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'vv-visual-api-storage-'));
  await ensureIntegrationDb();
  // The shared integration DB file may predate the Baseline table (the
  // helper only probes older tables) — push the schema when it is missing.
  try {
    await db().baseline.findMany({ take: 1 });
  } catch {
    const { execFileSync } = await import('node:child_process');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    execFileSync(
      process.execPath,
      [resolve(root, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--schema', resolve(root, 'prisma', 'schema.prisma'), '--skip-generate'],
      { stdio: 'pipe', env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL } },
    );
  }
  app = Fastify();
  await app.register(visualRoutes);
  await app.register(pluginRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('listen failed');
  httpBase = `http://127.0.0.1:${addr.port}`;

  await db().user.upsert({
    where: { id: 'u_visual_stranger' },
    update: {},
    create: { id: 'u_visual_stranger', email: 'visual-stranger@test.local', authRef: 'x', role: 'tester' },
  });
  const project = await db().project.create({ data: { name: 'visual-api-proj' } });
  projectId = project.id;
  await db().projectMember.create({ data: { projectId, userId: TEST_USER_ID, role: 'editor' } });
  const env = await db().environment.create({
    data: { projectId, name: 'visual-env', baseUrl: 'http://127.0.0.1:3123' },
  });
  envId = env.id;
  const test = await db().test.create({
    data: {
      projectId,
      name: 'visual api test',
      definitionJson: JSON.stringify({
        schemaVersion: '1.0', id: 't_visual_api', projectId, name: 'visual api test',
        browser: 'chromium',
        steps: [{ id: 'v1', type: 'visualCheck', enabled: true, name: 'hero' }],
      }),
      createdBy: TEST_USER_ID,
    },
  });
  testId = test.id;
  const run = await db().run.create({
    data: { projectId, testId, environmentId: envId, browser: 'chromium', status: 'passed', trigger: 'manual' },
  });
  runId = run.id;
  // Seed the visual actual artifact exactly as a worker would produce it.
  const rel = `runs/${runId}/screenshots/visual-hero.png`;
  const abs = join(process.env.STORAGE_ROOT, 'runs', runId, 'screenshots');
  mkdirSync(abs, { recursive: true });
  writeFileSync(join(abs, 'visual-hero.png'), solidPng(8, 8, 10, 20, 30));
  const artifact = await db().artifact.create({
    data: { runId, type: 'screenshot', path: rel, mimeType: 'image/png', sizeBytes: 100 },
  });
  artifactId = artifact.id;
  void envId;
});

after(async () => {
  await app.close();
});

describe('baselines CRUD + promote + serve', () => {
  it('lists empty, promotes an artifact, serves it, updates, deletes', async () => {
    let res = await injectJson(app, 'GET', `/api/v1/tests/${testId}/baselines`);
    // Standalone instance has no /api/v1 prefix: routes mount at root here.
    assert.equal(res.statusCode, 404);
    res = await injectJson(app, 'GET', `/tests/${testId}/baselines`);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);

    res = await injectJson(app, 'POST', `/tests/${testId}/baselines`, { name: 'hero', runId });
    assert.equal(res.statusCode, 201);
    const created = res.json() as Record<string, unknown>;
    assert.equal(created['name'], 'hero');
    assert.equal(created['width'], 8);
    assert.equal(created['height'], 8);
    assert.ok(!('path' in created), 'absolute storage path must never reach clients');

    const imgRes = await fetch(`${httpBase}/tests/${testId}/baselines/hero/image`, {
      headers: { 'x-user-id': TEST_USER_ID },
    });
    assert.equal(imgRes.status, 200);
    assert.match(imgRes.headers.get('content-type') ?? '', /image\/png/);
    const imgBytes = Buffer.from(await imgRes.arrayBuffer());
    assert.deepEqual(imgBytes.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    // Re-promote replaces bytes (200 update path).
    res = await injectJson(app, 'POST', `/tests/${testId}/baselines`, { name: 'hero', runId });
    assert.equal(res.statusCode, 200);

    res = await injectJson(app, 'DELETE', `/tests/${testId}/baselines/hero`);
    assert.equal(res.statusCode, 204);
    res = await injectJson(app, 'GET', `/tests/${testId}/baselines/hero/image`);
    assert.equal(res.statusCode, 404);
  });

  it('rejects bad promote inputs explicitly', async () => {
    let res = await injectJson(app, 'POST', `/tests/${testId}/baselines`, { name: 'ghost', runId: 'run_nope' });
    assert.equal(res.statusCode, 400);
    res = await injectJson(app, 'POST', `/tests/${testId}/baselines`, { name: '../evil', runId });
    assert.equal(res.statusCode, 400);
    res = await injectJson(app, 'POST', `/tests/${testId}/baselines`, {
      name: 'hero', runId, artifactPath: `runs/${runId}/screenshots/nope.exe`,
    });
    assert.equal(res.statusCode, 400);
    // Non-PNG artifact bytes are rejected (bad magic).
    const txtRel = `runs/${runId}/screenshots/notes.txt`;
    writeFileSync(join(process.env.STORAGE_ROOT, txtRel), 'hello');
    await db().artifact.create({ data: { runId, type: 'screenshot', path: txtRel, mimeType: 'text/plain' } });
    res = await injectJson(app, 'POST', `/tests/${testId}/baselines`, { name: 'txt', runId, artifactPath: txtRel });
    assert.equal(res.statusCode, 400);
  });

  it('enforces auth + membership (401/403)', async () => {
    const anon = await app.inject({ method: 'GET', url: `/tests/${testId}/baselines` });
    assert.equal(anon.statusCode, 401);
    const stranger = await app.inject({
      method: 'GET', url: `/tests/${testId}/baselines`, headers: { 'x-user-id': 'u_visual_stranger' },
    });
    assert.equal(stranger.statusCode, 403);
    const strangerPost = await app.inject({
      method: 'POST', url: `/tests/${testId}/baselines`,
      headers: strangerHeaders(), payload: JSON.stringify({ name: 'x', runId }),
    });
    assert.equal(strangerPost.statusCode, 403);
  });
});

describe('run artifact image serve', () => {
  it('serves recorded images, blocks non-images and foreigners', async () => {
    const imgRes = await fetch(`${httpBase}/runs/${runId}/artifacts/${artifactId}/image`, {
      headers: { 'x-user-id': TEST_USER_ID },
    });
    assert.equal(imgRes.status, 200);
    assert.match(imgRes.headers.get('content-type') ?? '', /image\/png/);
    assert.ok((await imgRes.arrayBuffer()).byteLength > 8);

    const other = await app.inject({
      method: 'GET', url: `/runs/${runId}/artifacts/${artifactId}/image`,
      headers: { 'x-user-id': 'u_visual_stranger' },
    });
    assert.equal(other.statusCode, 403);

    const missing = await app.inject({
      method: 'GET', url: `/runs/${runId}/artifacts/aid_nope/image`,
      headers: { 'x-user-id': TEST_USER_ID },
    });
    assert.equal(missing.statusCode, 404);

    const log = await db().artifact.create({
      data: { runId, type: 'screenshot', path: `runs/${runId}/log.txt`, mimeType: 'text/plain' },
    });
    const nonImage = await app.inject({
      method: 'GET', url: `/runs/${runId}/artifacts/${log.id}/image`,
      headers: { 'x-user-id': TEST_USER_ID },
    });
    assert.equal(nonImage.statusCode, 400);
  });
});

describe('visual-runs validation', () => {
  it('rejects unknown test / foreign env / plugin flag for testers', async () => {
    let res = await injectJson(app, 'POST', '/tests/test_nope/visual-runs', { environmentId: envId });
    assert.equal(res.statusCode, 404);
    // A truly foreign env (another project) is rejected.
    const foreignProject = await db().project.create({ data: { name: `unrelated-${Date.now()}` } });
    const foreignEnv = await db().environment.create({
      data: { projectId: foreignProject.id, name: `foreign-env-${Date.now()}` },
    });
    res = await injectJson(app, 'POST', `/tests/${testId}/visual-runs`, { environmentId: foreignEnv.id });
    assert.equal(res.statusCode, 400);
    // plugins require Developer/Admin: the P0 auth stub always resolves 'tester'.
    res = await injectJson(app, 'POST', `/tests/${testId}/visual-runs`, { environmentId: envId, usePlugins: true });
    assert.equal(res.statusCode, 403);
  });
});

describe('plugin routes', () => {
  it('GET /plugins reports disabled by default (never 500)', async () => {
    const prev = process.env.ALLOW_PLUGINS;
    delete process.env.ALLOW_PLUGINS;
    try {
      const res = await injectJson(app, 'GET', '/plugins');
      assert.equal(res.statusCode, 200);
      assert.equal((res.json() as { enabled: boolean }).enabled, false);
    } finally {
      if (prev !== undefined) process.env.ALLOW_PLUGINS = prev;
    }
  });

  it('GET /plugins lists manifests when enabled; reload is privileged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vv-api-plugins-'));
    writeFileSync(
      join(dir, 'demo.cjs'),
      `module.exports = { name: 'demo', version: '1.0.0', steps: [{ type: 'plugin:demo.hello', description: 'hi', execute() {} }] };`,
    );
    process.env.ALLOW_PLUGINS = '1';
    process.env.PLUGINS_DIR = dir;
    try {
      const res = await injectJson(app, 'GET', '/plugins');
      assert.equal(res.statusCode, 200);
      const body = res.json() as { enabled: boolean; plugins: Array<{ name: string; steps: unknown[] }> };
      assert.equal(body.enabled, true);
      assert.equal(body.plugins.length, 1);
      assert.equal(body.plugins[0]!.name, 'demo');
      const json = JSON.stringify(body);
      assert.ok(!json.includes('execute'), 'execute source must not leak');
      // Reload requires Developer/Admin; the P0 auth stub resolves 'tester'.
      const reload = await injectJson(app, 'POST', '/plugins/reload');
      assert.equal(reload.statusCode, 403);
    } finally {
      delete process.env.ALLOW_PLUGINS;
      delete process.env.PLUGINS_DIR;
    }
  });
});
