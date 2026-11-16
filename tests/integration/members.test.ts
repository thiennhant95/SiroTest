/**
 * Integration: project member management (Settings → Members).
 * Pure API (no browser). Verifies:
 * - owner lists members (owner first), adds by email, changes role, removes
 * - adding an unknown email → 404 with a clear message
 * - duplicate add → 409
 * - editor cannot add/change/remove (403)
 * - last owner cannot be removed
 * - every change writes an audit row (awaited before the response)
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
const tag = `members${Date.now().toString(36)}`;
const U = (id: string) => ({ 'x-user-id': id });

async function call(method: string, url: string, user: string, body?: unknown) {
  const headers: Record<string, string> = { ...U(user) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.inject({ method, url, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
}

const OWNER = `${tag}-owner`;
const EDITOR = `${tag}-editor`;
const NEWBIE = `${tag}-newbie`;
const NEWBIE_EMAIL = `${tag}@example.com`;
let projectId = '';

before(async () => {
  await ensureIntegrationDb();
  app = await buildApp();

  const created = await call('POST', '/api/v1/projects', OWNER, { name: `${tag} project` });
  assert.equal(created.statusCode, 201);
  projectId = created.json().id;

  // The new teammate signed up (user row exists) but has no membership yet.
  await call('POST', '/api/v1/auth/register', NEWBIE, { email: NEWBIE_EMAIL, password: 'secret-pass-123' });

  await db.user.upsert({
    where: { id: EDITOR },
    update: {},
    create: { id: EDITOR, email: `${tag}-editor@example.com`, authRef: 'x', role: 'tester' },
  });
  await db.projectMember.create({ data: { projectId, userId: EDITOR, role: 'editor' } });
});

after(async () => {
  await db.auditLog.deleteMany({ where: { projectId } });
  await db.projectMember.deleteMany({ where: { projectId } });
  await db.project.deleteMany({ where: { id: projectId } });
  await db.user.deleteMany({ where: { email: NEWBIE_EMAIL } });
  await db.user.deleteMany({ where: { id: EDITOR } });
  await db.$disconnect();
  await app.close();
});

describe('project members', () => {
  it('lists the owner first', async () => {
    const res = await call('GET', `/api/v1/projects/${projectId}/members`, OWNER);
    assert.equal(res.statusCode, 200);
    const rows = res.json() as Array<{ role: string; userId: string }>;
    assert.equal(rows[0].role, 'owner');
    assert.ok(rows.some((r) => r.userId === EDITOR && r.role === 'editor'));
  });

  it('rejects an unknown email with a clear message', async () => {
    const res = await call('POST', `/api/v1/projects/${projectId}/members`, OWNER, {
      email: `nobody-${tag}@example.com`,
      role: 'viewer',
    });
    assert.equal(res.statusCode, 404);
    assert.match(res.json().message, /sign up first/i);
  });

  it('adds a signed-up user, then rejects a duplicate', async () => {
    const add = await call('POST', `/api/v1/projects/${projectId}/members`, OWNER, {
      email: NEWBIE_EMAIL,
      role: 'viewer',
    });
    assert.equal(add.statusCode, 201);
    assert.equal(add.json().role, 'viewer');

    const dup = await call('POST', `/api/v1/projects/${projectId}/members`, OWNER, {
      email: NEWBIE_EMAIL,
      role: 'editor',
    });
    assert.equal(dup.statusCode, 409);
  });

  it('changes a member role and audits it', async () => {
    const rows = (await call('GET', `/api/v1/projects/${projectId}/members`, OWNER)).json() as Array<{
      userId: string;
      email: string;
      role: string;
    }>;
    const newbie = rows.find((r) => r.email === NEWBIE_EMAIL)!;
    const res = await call('PATCH', `/api/v1/projects/${projectId}/members/${newbie.userId}`, OWNER, { role: 'editor' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().role, 'editor');

    const audit = await db.auditLog.findFirst({
      where: { projectId, action: 'project.member_role', entityId: newbie.userId },
    });
    assert.ok(audit, 'audit row written before response');
  });

  it('blocks editors from managing members', async () => {
    const res = await call('POST', `/api/v1/projects/${projectId}/members`, EDITOR, {
      email: NEWBIE_EMAIL,
      role: 'viewer',
    });
    assert.equal(res.statusCode, 403);
  });

  it('removes a member and audits it', async () => {
    const rows = (await call('GET', `/api/v1/projects/${projectId}/members`, OWNER)).json() as Array<{
      userId: string;
      email: string;
    }>;
    const newbie = rows.find((r) => r.email === NEWBIE_EMAIL)!;
    const res = await call('DELETE', `/api/v1/projects/${projectId}/members/${newbie.userId}`, OWNER);
    assert.equal(res.statusCode, 204);

    const audit = await db.auditLog.findFirst({
      where: { projectId, action: 'project.member_remove', entityId: newbie.userId },
    });
    assert.ok(audit);
  });

  it('refuses to remove the last owner', async () => {
    const rows = (await call('GET', `/api/v1/projects/${projectId}/members`, OWNER)).json() as Array<{
      userId: string;
      role: string;
    }>;
    const owner = rows.find((r) => r.role === 'owner')!;
    const res = await call('DELETE', `/api/v1/projects/${projectId}/members/${owner.userId}`, OWNER);
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /last owner/i);
  });
});
