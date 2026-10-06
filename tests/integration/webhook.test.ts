/**
 * Integration: generic HMAC webhook provider + run-terminal fan-out.
 * Stub HTTP server captures posts; signature recomputed locally.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { ensureIntegrationDb } from './helpers.js';

process.env.SKIP_LISTEN = '1';
const { buildApp } = await import('../../apps/server/src/app.js');
const { notifyRunWebhooks } = await import('../../apps/server/src/integrations.js');

let app: FastifyInstance;
const tag = `wh${Date.now().toString(36)}`;
const SECRET = 'test-signing-secret';
const U = { 'x-user-id': `${tag}-owner` };

async function call(method: string, url: string, body?: unknown) {
  const headers: Record<string, string> = { ...U };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.inject({ method, url, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
}

const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
let stub: ReturnType<typeof createServer>;
let stubPort = 0;
let projectId = '';

before(async () => {
  await ensureIntegrationDb();
  app = await buildApp();
  stub = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, body: data });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
  stubPort = (stub.address() as { port: number }).port;
  projectId = ((await call('POST', '/api/v1/projects', { name: `${tag}-proj` })).json() as { id: string }).id;
});

after(async () => {
  stub.close();
  await app.close();
});

describe('webhook provider', () => {
  it('CRUD accepts webhook + fan-out posts signed event', async () => {
    const created = await call('POST', `/api/v1/projects/${projectId}/integrations`, {
      provider: 'webhook', name: 'ci', config: { url: `http://127.0.0.1:${stubPort}/hook` }, secrets: { signingSecret: SECRET },
    });
    assert.equal(created.statusCode, 201);
    await notifyRunWebhooks({
      projectId, event: 'run.failed', runId: 'run_1', status: 'failed',
      trigger: 'schedule', testName: 'Nightly', errorSummary: 'boom',
    });
    assert.equal(received.length, 1);
    const { headers, body } = received[0]!;
    const parsed = JSON.parse(body) as { event: string; title: string; markdown: string };
    assert.equal(parsed.event, 'run.failed');
    assert.match(parsed.title, /Nightly/);
    assert.match(parsed.markdown, /boom/);
    assert.equal(headers['x-vv-event'], 'run.failed');
    const expected = `v1=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}`;
    assert.equal(headers['x-vv-signature'], expected);
  });
  it('no webhook configured → silent no-op', async () => {
    const other = ((await call('POST', '/api/v1/projects', { name: `${tag}-proj2` })).json() as { id: string }).id;
    const before = received.length;
    await notifyRunWebhooks({ projectId: other, event: 'run.passed', runId: 'run_2', status: 'passed' });
    assert.equal(received.length, before);
  });
  it('unsigned webhook sends without signature', async () => {
    const created = await call('POST', `/api/v1/projects/${projectId}/integrations`, {
      provider: 'webhook', name: 'plain', config: { url: `http://127.0.0.1:${stubPort}/hook2` },
    });
    assert.equal(created.statusCode, 201);
    const before = received.length;
    await notifyRunWebhooks({ projectId, event: 'run.passed', runId: 'run_3', status: 'passed' });
    // both integrations fire (signed 'ci' + unsigned 'plain')
    const hits = received.slice(before).filter((r) => (JSON.parse(r.body) as { markdown: string }).markdown.includes('run_3'));
    assert.equal(hits.length, 2);
    assert.ok(hits.some((h) => typeof h.headers['x-vv-signature'] === 'string'));
    assert.ok(hits.some((h) => h.headers['x-vv-signature'] === undefined));
  });
});
