/**
 * Integration: Vietnamese Gherkin preview (POST /ai/gherkin, rules only).
 * Pure API (no browser). Stateless preview — nothing is persisted.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ensureIntegrationDb } from './helpers.js';

process.env.SKIP_LISTEN = '1';
const { buildApp } = await import('../../apps/server/src/app.js');

let app: FastifyInstance;
const tag = `gh${Date.now().toString(36)}`;
const OWNER = `${tag}-owner`;
const GHOST = `ghost-${tag}`;

function callAs(user: string, body?: unknown) {
  const headers: Record<string, string> = { 'x-user-id': user };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.inject({
    method: 'POST',
    url: '/api/v1/ai/gherkin',
    headers,
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
}

const LOGIN_TEXT = `@smoke @login
Tính năng: Đăng nhập admin
  Bối cảnh:
    Cho rằng mở trang https://example.com/admin/login
  Kịch bản: Login thành công
    Khi nhập "Email Address" là "admin@x.io"
    Và nhập "Password" là "123456"
    Và bấm nút "Sign In"
    Thì kiểm tra "Dashboard" hiển thị`;

let foreignProjectId = '';

before(async () => {
  await ensureIntegrationDb();
  app = await buildApp();
  const headers: Record<string, string> = { 'x-user-id': OWNER, 'content-type': 'application/json' };
  const p = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers,
    payload: JSON.stringify({ name: `${tag}-proj` }),
  });
  assert.equal(p.statusCode, 201);
  foreignProjectId = (p.json() as { id: string }).id;
});

after(async () => {
  await app.close();
});

describe('POST /ai/gherkin', () => {
  it('VI login flow → goto,fill,fill,click,assertVisible with scenarioName + tags', async () => {
    const res = await callAs(OWNER, { text: LOGIN_TEXT });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      engine: string;
      steps: Array<{ type: string }>;
      unparsed: string[];
      warnings: string[];
      scenarioName?: string;
      tags: string[];
    };
    assert.equal(body.engine, 'rules');
    assert.deepEqual(body.steps.map((s) => s.type), ['goto', 'fill', 'fill', 'click', 'assertVisible']);
    assert.deepEqual(body.unparsed, []);
    assert.ok(body.scenarioName, 'scenarioName present');
    assert.ok(body.tags.includes('smoke') && body.tags.includes('login'), 'tags present');
  });

  it('garbage text → unparsed explicit, zero fabricated steps', async () => {
    const res = await callAs(OWNER, { text: 'mớ hỗn độn không có nghĩa gì cả\n!!! ??? @@@' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { engine: string; steps: unknown[]; unparsed: string[] };
    assert.equal(body.engine, 'rules');
    assert.equal(body.steps.length, 0);
    assert.ok(body.unparsed.length > 0, 'unparsed non-empty');
  });

  it('outsider projectId → 403', async () => {
    const res = await callAs(GHOST, { text: LOGIN_TEXT, projectId: foreignProjectId });
    assert.equal(res.statusCode, 403);
  });

  it('empty text → 400', async () => {
    const res = await callAs(OWNER, { text: '' });
    assert.equal(res.statusCode, 400);
  });
});
