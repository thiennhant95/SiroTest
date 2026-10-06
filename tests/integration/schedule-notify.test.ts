/**
 * Integration: schedule failure alerting (opt-in chat notification).
 * Uses a local stub webhook as the Slack endpoint — proves the real HTTP
 * POST path (title + markdown) without external services. No browser.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createServer } from 'node:http';
import { ensureIntegrationDb } from './helpers.js';

process.env.SKIP_LISTEN = '1';
const { buildApp } = await import('../../apps/server/src/app.js');
const { onScheduleRunSettled } = await import('../../apps/server/src/scheduler.js');

let app: FastifyInstance;
const tag = `ntf${Date.now().toString(36)}`;
const U = { 'x-user-id': `${tag}-owner` };

async function call(method: string, url: string, body?: unknown) {
  const headers: Record<string, string> = { ...U };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.inject({ method, url, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
}

const received: Array<{ url: string; body: string }> = [];
let stub: ReturnType<typeof createServer>;
let stubPort = 0;

let projectId = '';
let envId = '';
let testId = '';
let schedId = '';

before(async () => {
  await ensureIntegrationDb();
  app = await buildApp();
  stub = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      received.push({ url: req.url ?? '', body: data });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
  stubPort = (stub.address() as { port: number }).port;

  projectId = ((await call('POST', '/api/v1/projects', { name: `${tag}-proj` })).json() as { id: string }).id;
  envId = ((await call('POST', `/api/v1/projects/${projectId}/environments`, { name: 'e', baseUrl: 'https://example.com' })).json() as { id: string }).id;
  testId = ((await call('POST', `/api/v1/projects/${projectId}/tests`, {
    name: `${tag}-t`,
    definitionJson: { schemaVersion: '1.0', name: 't', browser: 'chromium', steps: [{ id: 's1', type: 'goto', enabled: true, name: 'Go', url: 'https://example.com' }] },
  })).json() as { id: string }).id;
  const integ = await call('POST', `/api/v1/projects/${projectId}/integrations`, {
    provider: 'slack', name: 'chat', config: { webhookUrl: `http://127.0.0.1:${stubPort}/hook` },
  });
  assert.equal(integ.statusCode, 201);
  const sched = await call('POST', `/api/v1/projects/${projectId}/schedules`, {
    testId, environmentId: envId, cron: '0 0 1 1 *', enabled: false, notifyOnFailure: true,
  });
  assert.equal(sched.statusCode, 201);
  schedId = (sched.json() as { id: string }).id;
});

after(async () => {
  stub.close();
  await app.close();
});

describe('schedule failure alerting', () => {
  it('CRUD roundtrips notifyOnFailure', async () => {
    const got = (await call('GET', `/api/v1/schedules/${schedId}`)).json() as { notifyOnFailure: boolean };
    assert.equal(got.notifyOnFailure, true);
    const patched = (await call('PATCH', `/api/v1/schedules/${schedId}`, { notifyOnFailure: false })).json() as { notifyOnFailure: boolean };
    assert.equal(patched.notifyOnFailure, false);
    await call('PATCH', `/api/v1/schedules/${schedId}`, { notifyOnFailure: true });
  });
  it('failed settle posts to chat and records lastStatus', async () => {
    await onScheduleRunSettled(schedId, { status: 'failed', runId: 'run_x', errorSummary: 'boom' });
    assert.equal(received.length, 1);
    const payload = JSON.parse(received[0]!.body) as { text: string };
    assert.match(payload.text, /FAILED/);
    assert.match(payload.text, new RegExp(`${tag}-t`));
    assert.match(payload.text, /boom/);
    const got = (await call('GET', `/api/v1/schedules/${schedId}`)).json() as { lastStatus: string };
    assert.equal(got.lastStatus, 'failed');
  });
  it('passed settle records lastStatus without posting', async () => {
    const before = received.length;
    await onScheduleRunSettled(schedId, { status: 'passed', runId: 'run_y' });
    assert.equal(received.length, before);
    const got = (await call('GET', `/api/v1/schedules/${schedId}`)).json() as { lastStatus: string };
    assert.equal(got.lastStatus, 'passed');
  });
  it('failed settle without opt-in records lastStatus without posting', async () => {
    await call('PATCH', `/api/v1/schedules/${schedId}`, { notifyOnFailure: false });
    const before = received.length;
    await onScheduleRunSettled(schedId, { status: 'failed', runId: 'run_z', errorSummary: 'x' });
    assert.equal(received.length, before);
    const got = (await call('GET', `/api/v1/schedules/${schedId}`)).json() as { lastStatus: string };
    assert.equal(got.lastStatus, 'failed');
  });
  it('run-now: unknown 404, viewer 403, dangling target 400', async () => {
    assert.equal((await call('POST', '/api/v1/schedules/sched_nope/runs', {})).statusCode, 404);
    const tmp = ((await call('POST', `/api/v1/projects/${projectId}/tests`, {
      name: `${tag}-tmp`,
      definitionJson: { schemaVersion: '1.0', name: 't', browser: 'chromium', steps: [{ id: 's1', type: 'goto', enabled: true, name: 'Go', url: 'https://example.com' }] },
    })).json() as { id: string }).id;
    const sched = ((await call('POST', `/api/v1/projects/${projectId}/schedules`, {
      testId: tmp, environmentId: envId, cron: '0 0 1 1 *', enabled: false,
    })).json() as { id: string });
    const headers: Record<string, string> = { 'x-user-id': `${tag}-viewer`, 'content-type': 'application/json' };
    // viewer user without membership → 403 (proves write gate on run-now)
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/schedules/${sched.id}/runs`, headers, payload: '{}' })).statusCode, 403);
    assert.equal((await call('DELETE', `/api/v1/tests/${tmp}`)).statusCode, 204);
    assert.equal((await call('POST', `/api/v1/schedules/${sched.id}/runs`, {})).statusCode, 400);
    assert.equal((await call('DELETE', `/api/v1/schedules/${sched.id}`)).statusCode, 204);
  });
});
