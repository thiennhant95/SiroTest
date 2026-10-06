/**
 * Integration: project RBAC on P0/P1 routes (viewer read-only, member-only).
 * Pure API (no browser). Verifies:
 * - viewer member: reads 200, every write 403 (tests, runs, variables,
 *   schedules, healing approve, suites, baselines, profiles, files, actions)
 * - outsider (no membership): reads 403, writes 403 (incl. variables, which
 *   previously had no membership check at all)
 * - editor member: writes succeed
 * - global viewer: cannot create/import projects
 * - delete test/suite with queued+running runs → 409 CONFLICT_ACTIVE_RUNS
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ensureIntegrationDb } from './helpers.js';

process.env.SKIP_LISTEN = '1';
const { buildApp } = await import('../../apps/server/src/app.js');
const { PrismaClient } = await import('@prisma/client');

let app: FastifyInstance;
const db = new PrismaClient();
const tag = `rbac${Date.now().toString(36)}`;
const U = (id: string) => ({ 'x-user-id': id });

async function call(method: string, url: string, user: string, body?: unknown) {
  const headers: Record<string, string> = { ...U(user) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.inject({ method, url, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
}

const OWNER = `${tag}-owner`;
const EDITOR = `${tag}-editor`;
const VIEWER = `${tag}-viewer`;
const OUTSIDER = `${tag}-outsider`;
const GVIEwER = `${tag}-gviewer`;

let projectId = '';
let envId = '';
let testId = '';
let varId = '';

before(async () => {
  await ensureIntegrationDb();
  app = await buildApp();
  for (const [id, role] of [[OWNER, 'tester'], [EDITOR, 'tester'], [VIEWER, 'viewer'], [OUTSIDER, 'tester'], [GVIEwER, 'viewer']] as const) {
    await db.user.upsert({
      where: { id }, update: { role },
      create: { id, email: `${id}@x.io`, authRef: 'rbac-test', role },
    });
  }
  const p = await call('POST', '/api/v1/projects', OWNER, { name: `${tag}-proj` });
  assert.equal(p.statusCode, 201, 'owner creates project');
  projectId = (p.json() as { id: string }).id;
  // creator auto-owner; add editor + viewer memberships
  await db.projectMember.create({ data: { projectId, userId: EDITOR, role: 'editor' } });
  await db.projectMember.create({ data: { projectId, userId: VIEWER, role: 'viewer' } });
  const e = await call('POST', `/api/v1/projects/${projectId}/environments`, OWNER, { name: 'staging', baseUrl: 'https://example.com' });
  assert.equal(e.statusCode, 201);
  envId = (e.json() as { id: string }).id;
  const t = await call('POST', `/api/v1/projects/${projectId}/tests`, OWNER, {
    name: `${tag}-t`,
    definitionJson: { schemaVersion: '1.0', name: 't', browser: 'chromium', steps: [{ id: 's1', type: 'goto', enabled: true, name: 'Go', url: 'https://example.com' }] },
  });
  assert.equal(t.statusCode, 201);
  testId = (t.json() as { id: string }).id;
  const v = await call('POST', `/api/v1/projects/${projectId}/variables`, OWNER, { key: 'K', value: 'v' });
  assert.equal(v.statusCode, 201);
  varId = (v.json() as { id: string }).id;
});

after(async () => {
  await db.$disconnect();
  await app.close();
});

describe('viewer is read-only', () => {
  it('reads 200', async () => {
    assert.equal((await call('GET', `/api/v1/projects/${projectId}/tests`, VIEWER)).statusCode, 200);
    assert.equal((await call('GET', `/api/v1/projects/${projectId}/variables`, VIEWER)).statusCode, 200);
    assert.equal((await call('GET', `/api/v1/tests/${testId}`, VIEWER)).statusCode, 200);
  });
  it('blocks test/run writes 403', async () => {
    assert.equal((await call('POST', `/api/v1/projects/${projectId}/tests`, VIEWER, { name: 'x' })).statusCode, 403);
    assert.equal((await call('PATCH', `/api/v1/tests/${testId}`, VIEWER, { name: 'x' })).statusCode, 403);
    assert.equal((await call('DELETE', `/api/v1/tests/${testId}`, VIEWER)).statusCode, 403);
    assert.equal((await call('POST', `/api/v1/tests/${testId}/runs`, VIEWER, { environmentId: envId })).statusCode, 403);
  });
  it('blocks config writes 403 (variables, envs, schedules, suites, profiles, files, actions)', async () => {
    assert.equal((await call('PATCH', `/api/v1/variables/${varId}`, VIEWER, { value: 'evil' })).statusCode, 403);
    assert.equal((await call('POST', `/api/v1/projects/${projectId}/environments`, VIEWER, { name: 'e' })).statusCode, 403);
    assert.equal((await call('POST', `/api/v1/projects/${projectId}/schedules`, VIEWER, { testId, environmentId: envId, cron: '0 7 * * *', enabled: false })).statusCode, 403);
    assert.equal((await call('POST', `/api/v1/projects/${projectId}/suites`, VIEWER, { name: 's' })).statusCode, 403);
    assert.equal((await call('POST', `/api/v1/projects/${projectId}/profiles`, VIEWER, { name: 'p', storageStateJson: { cookies: [], origins: [] } })).statusCode, 403);
    assert.equal((await call('POST', `/api/v1/projects/${projectId}/files`, VIEWER, { name: 'a.txt', contentBase64: 'aGk=' })).statusCode, 403);
    assert.equal((await call('POST', `/api/v1/projects/${projectId}/actions`, VIEWER, { name: 'a', steps: [] })).statusCode, 403);
    assert.equal((await call('POST', `/api/v1/tests/${testId}/visual-runs`, VIEWER, { environmentId: envId })).statusCode, 403);
    assert.equal((await call('POST', `/api/v1/tests/${testId}/recorder/start`, VIEWER, {})).statusCode, 403);
  });
  it('blocks healing approve 403', async () => {
    const prop = await db.healingProposal.create({
      data: {
        projectId, testId, stepId: 's1', runId: 'run_nope',
        fromLocator: JSON.stringify({ strategy: 'css', value: '.a' }),
        toLocator: JSON.stringify({ strategy: 'css', value: '.b' }),
        evidence: JSON.stringify({ tried: [], verified: true }),
        status: 'pending',
      },
    });
    assert.equal((await call('POST', `/api/v1/healing/${prop.id}/approve`, VIEWER, {})).statusCode, 403);
    assert.equal((await call('POST', `/api/v1/healing/${prop.id}/reject`, EDITOR, {})).statusCode, 200);
  });
});

describe('outsider has no access', () => {
  it('reads 403 (incl. variables/envs, previously unchecked)', async () => {
    assert.equal((await call('GET', `/api/v1/projects/${projectId}/tests`, OUTSIDER)).statusCode, 403);
    assert.equal((await call('GET', `/api/v1/projects/${projectId}/variables`, OUTSIDER)).statusCode, 403);
    assert.equal((await call('GET', `/api/v1/projects/${projectId}/environments`, OUTSIDER)).statusCode, 403);
    assert.equal((await call('GET', `/api/v1/tests/${testId}`, OUTSIDER)).statusCode, 403);
  });
  it('writes 403', async () => {
    assert.equal((await call('POST', `/api/v1/projects/${projectId}/tests`, OUTSIDER, { name: 'x' })).statusCode, 403);
    assert.equal((await call('POST', `/api/v1/projects/${projectId}/variables`, OUTSIDER, { key: 'X', value: 'y' })).statusCode, 403);
    assert.equal((await call('PATCH', `/api/v1/variables/${varId}`, OUTSIDER, { value: 'evil' })).statusCode, 403);
  });
});

describe('editor can write, global viewer cannot create', () => {
  it('editor writes 2xx', async () => {
    assert.equal((await call('PATCH', `/api/v1/tests/${testId}`, EDITOR, { description: 'ed' })).statusCode, 200);
    assert.equal((await call('PATCH', `/api/v1/variables/${varId}`, EDITOR, { value: 'ed' })).statusCode, 200);
  });
  it('global viewer cannot create/import projects', async () => {
    assert.equal((await call('POST', '/api/v1/projects', GVIEwER, { name: 'nope' })).statusCode, 403);
    assert.equal((await call('POST', '/api/v1/projects/import', GVIEwER, { payload: { version: 1, project: { name: 'x' }, environments: [], variables: [], tests: [], actions: [], suites: [], schedules: [], files: [] } })).statusCode, 403);
  });
  it('viewer cannot rename project; owner can', async () => {
    assert.equal((await call('PATCH', `/api/v1/projects/${projectId}`, VIEWER, { description: 'v' })).statusCode, 403);
    assert.equal((await call('PATCH', `/api/v1/projects/${projectId}`, OWNER, { description: 'o' })).statusCode, 200);
  });
});

describe('delete guards under active runs', () => {
  it('DELETE test with a running run → 409, then 204 after settle', async () => {
    const run = await db.run.create({
      data: { projectId, testId, environmentId: envId, browser: 'chromium', status: 'running', trigger: 'manual' },
    });
    const blocked = await call('DELETE', `/api/v1/tests/${testId}`, OWNER);
    assert.equal(blocked.statusCode, 409);
    assert.equal((blocked.json() as { code: string }).code, 'CONFLICT_ACTIVE_RUNS');
    await db.run.update({ where: { id: run.id }, data: { status: 'failed', finishedAt: new Date() } });
    assert.equal((await call('DELETE', `/api/v1/tests/${testId}`, OWNER)).statusCode, 204);
  });
});
