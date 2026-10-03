/**
 * Integration: real session auth (register/login/logout/me + Bearer).
 * Pure API (no browser). Every test uses unique emails (shared DB file).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ensureIntegrationDb } from './helpers.js';

process.env.SKIP_LISTEN = '1';
const { buildApp } = await import('../../apps/server/src/app.js');

let app: FastifyInstance;
const tag = `auth${Date.now().toString(36)}`;

before(async () => {
  await ensureIntegrationDb();
  app = await buildApp();
});

after(async () => {
  await app.close();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });
}

const H = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('session auth (register/login/logout/me)', () => {
  it('registers, rejects duplicates, and returns a one-time token', async () => {
    const email = `${tag}-new@example.com`;
    const res = await post('/api/v1/auth/register', { email, name: 'T', password: 's3cret-pw' });
    assert.equal(res.statusCode, 201);
    const body = res.json() as { token: string; user: { id: string; email: string; role: string } };
    assert.ok(body.token.length >= 32, 'raw token returned once');
    assert.equal(body.user.email, email);
    assert.equal(body.user.role, 'tester');

    const dup = await post('/api/v1/auth/register', { email, password: 's3cret-pw' });
    assert.equal(dup.statusCode, 409);
    assert.equal((dup.json() as { code: string }).code, 'USER_EXISTS');

    const weak = await post('/api/v1/auth/register', { email: `${tag}-w@example.com`, password: 'short' });
    assert.equal(weak.statusCode, 400);
  });

  it('login verifies password without enumerating users; token authorizes', async () => {
    const email = `${tag}-login@example.com`;
    await post('/api/v1/auth/register', { email, password: 'right-horse-1' });

    const badPw = await post('/api/v1/auth/login', { email, password: 'wrong-horse-2' });
    assert.equal(badPw.statusCode, 401);
    assert.equal((badPw.json() as { code: string }).code, 'INVALID_CREDENTIALS');

    const noUser = await post('/api/v1/auth/login', { email: `${tag}-ghost@example.com`, password: 'whatever-1' });
    assert.equal(noUser.statusCode, 401);
    assert.equal((noUser.json() as { code: string }).code, 'INVALID_CREDENTIALS');

    const ok = await post('/api/v1/auth/login', { email, password: 'right-horse-1' });
    assert.equal(ok.statusCode, 200);
    const token = (ok.json() as { token: string }).token;
    assert.ok(token.length >= 32);

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: H(token) });
    assert.equal(me.statusCode, 200);
    assert.equal((me.json() as { email: string }).email, email);

    // Token authorizes project-scoped writes (owner flow).
    const project = await app.inject({
      method: 'POST', url: '/api/v1/projects',
      headers: { ...H(token), 'content-type': 'application/json' },
      payload: JSON.stringify({ name: `${tag}-proj` }),
    });
    assert.equal(project.statusCode, 201);

    // Logout revokes: the same token is rejected afterwards.
    const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: H(token) });
    assert.equal(logout.statusCode, 200);
    const after = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: H(token) });
    assert.equal(after.statusCode, 401);
  });

  it('legacy x-user-id dev auth keeps working (unless disabled)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: { 'x-user-id': `${tag}-dev` } });
    assert.equal(res.statusCode, 200);
  });
});
