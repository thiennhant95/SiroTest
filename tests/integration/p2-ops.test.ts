/**
 * Integration: P2 ops — distributed worker claim protocol, analytics/flaky
 * trends, audit log + granular RBAC, OIDC config validation (offline only).
 *
 * Strategy: isolated SQLite file (helpers.ensureIntegrationDb), Fastify app
 * built locally registering ONLY the new P2 plugins (app.ts is frozen by
 * task scope — see REGISTRATION CONTRACT in each route module). No browser,
 * no network, no migration.
 *
 * Run: npx tsx --test tests/integration/p2-ops.test.ts
 * (root package.json untouched — command documented here instead.)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ensureIntegrationDb, TEST_USER_ID } from './helpers.js';

// NOTE: 'fastify' is not resolvable from the repo root (pnpm isolated
// deps) — load the constructor through the server workspace package
// (same build the API uses). Type-only import above is erased at runtime.
const { default: Fastify } = (await import(
  '../../apps/server/node_modules/fastify/fastify.js'
)) as unknown as { default: (opts?: Record<string, unknown>) => FastifyInstance };

process.env.SKIP_LISTEN = '1';
const { toErrorBody } = await import('../../apps/server/src/errors.js');
const { db } = await import('../../apps/server/src/db.js');
const { workerRoutes, requeueStaleWorkers } = await import('../../apps/server/src/routes/workers.js');
const { analyticsRoutes } = await import('../../apps/server/src/routes/analytics.js');
const { auditRoutes, writeAudit } = await import('../../apps/server/src/routes/audit.js');
const {
  requireRole,
  buildOidcLoginUrl,
  decodeJwtPayloadUnsafe,
  readOidcConfig,
  validateOidcConfig,
} = await import('../../apps/server/src/rbac.js');

let app: FastifyInstance;
let n = 0;
const uid = (p: string): string => `${p}_${Date.now()}_${n++}`;

function headers(userId: string): Record<string, string> {
  return { 'x-user-id': userId, 'content-type': 'application/json' };
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, userId: string, body?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: body === undefined ? { 'x-user-id': userId } : headers(userId),
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = res.body ? JSON.parse(res.body) : null;
  } catch {
    json = null;
  }
  return { status: res.statusCode, json };
}

const VIEWER_ID = 'u_p2_viewer';
const EDITOR_ID = 'u_p2_editor';
const ADMIN_ID = 'u_p2_admin';
const OUTSIDER_ID = 'u_p2_outsider';

async function seedUser(id: string, role: string): Promise<void> {
  await db().user.upsert({
    where: { id },
    update: { role },
    create: { id, email: `${id}@test.local`, authRef: 'p2-test', role },
  });
}

async function seedProject(ownerId: string, memberId?: string, memberRole = 'viewer'): Promise<string> {
  const p = await db().project.create({ data: { name: uid('p2-proj') } });
  await db().projectMember.upsert({
    where: { projectId_userId: { projectId: p.id, userId: ownerId } },
    update: { role: 'owner' },
    create: { projectId: p.id, userId: ownerId, role: 'owner' },
  });
  if (memberId) {
    await db().projectMember.upsert({
      where: { projectId_userId: { projectId: p.id, userId: memberId } },
      update: { role: memberRole },
      create: { projectId: p.id, userId: memberId, role: memberRole },
    });
  }
  return p.id;
}

async function seedTest(projectId: string, name: string): Promise<string> {
  const t = await db().test.create({
    data: {
      projectId,
      name,
      definitionJson: JSON.stringify({ schemaVersion: '1.0', steps: [] }),
      createdBy: TEST_USER_ID,
    },
  });
  return t.id;
}

async function seedRun(opts: {  projectId: string;
  testId: string;
  status: string;
  browser?: string;
  durationMs?: number | null;
  finishedAt?: Date | null;
  errorSummary?: string | null;
  workerId?: string | null;
}): Promise<string> {
  const r = await db().run.create({
    data: {
      projectId: opts.projectId,
      testId: opts.testId,
      browser: opts.browser ?? 'chromium',
      status: opts.status,
      trigger: 'manual',
      ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
      ...(opts.finishedAt !== undefined ? { finishedAt: opts.finishedAt } : {}),
      ...(opts.errorSummary !== undefined ? { errorSummary: opts.errorSummary } : {}),
      ...(opts.workerId !== undefined ? { workerId: opts.workerId } : {}),
    },
  });
  return r.id;
}

/**
 * Claim protocol is global (oldest queued wins) and the integration DB is
 * shared across suites, which may leave orphan queued rows behind. Cancel
 * pre-existing queued rows before claim-order assertions so the queue holds
 * only this test's runs. Safe: orphan rows have no live worker in tests.
 */
async function quarantineQueuedRuns(): Promise<void> {
  await db().run.updateMany({
    where: { status: 'queued' },
    data: { status: 'cancelled', finishedAt: new Date() },
  });
}

before(async () => {
  await ensureIntegrationDb();
  await seedUser(VIEWER_ID, 'viewer');
  await seedUser(EDITOR_ID, 'tester');
  await seedUser(ADMIN_ID, 'admin');
  await seedUser(OUTSIDER_ID, 'tester');
  app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    const { statusCode, body } = toErrorBody(err);
    return reply.code(statusCode).send(body);
  });
  await app.register(workerRoutes);
  await app.register(analyticsRoutes);
  await app.register(auditRoutes);
});

after(async () => {
  await app.close();
});

describe('workers protocol', () => {
  it('registers (upsert by name) and lists workers', async () => {
    const first = await call('POST', '/api/v1/workers/register', EDITOR_ID, { name: uid('w-up'), capacity: 1 });
    assert.equal(first.status, 201);
    const w1 = first.json as { id: string; name: string; status: string; capacity: number };
    assert.equal(w1.status, 'online');

    const listed = await call('GET', '/api/v1/workers', EDITOR_ID);
    assert.equal(listed.status, 200);
    assert.ok((listed.json as unknown[]).some((w) => (w as { id: string }).id === w1.id));
  });

  it('heartbeat claims oldest queued run first and honors capacity', async () => {
    await quarantineQueuedRuns();
    const projectId = await seedProject(TEST_USER_ID);
    const testId = await seedTest(projectId, 'claim-order');
    const r1 = await seedRun({ projectId, testId, status: 'queued' });
    const r2 = await seedRun({ projectId, testId, status: 'queued' });

    const reg = await call('POST', '/api/v1/workers/register', EDITOR_ID, { name: uid('w-claim'), capacity: 1 });
    const wid = (reg.json as { id: string }).id;

    const hb1 = await call('POST', `/api/v1/workers/${wid}/heartbeat`, EDITOR_ID);
    assert.equal(hb1.status, 200);
    const c1 = (hb1.json as { claimedRun: { id: string; definitionJson: string } | null }).claimedRun;
    assert.ok(c1 && c1.id === r1, 'oldest queued run claimed first');
    assert.ok(c1.definitionJson, 'claimed run carries definition for remote execution');
    assert.equal((await db().run.findUnique({ where: { id: r1 } }))?.status, 'running');

    const hb2 = await call('POST', `/api/v1/workers/${wid}/heartbeat`, EDITOR_ID);
    assert.equal((hb2.json as { claimedRun: null }).claimedRun, null, 'capacity 1 blocks second claim');

    const done = await call('POST', `/api/v1/workers/${wid}/complete`, EDITOR_ID, {
      runId: r1, status: 'passed', durationMs: 1200,
    });
    assert.equal(done.status, 200);
    assert.equal((done.json as { status: string }).status, 'passed');

    const hb3 = await call('POST', `/api/v1/workers/${wid}/heartbeat`, EDITOR_ID);
    assert.equal((hb3.json as { claimedRun: { id: string } | null }).claimedRun?.id, r2);
  });

  it('complete rejects unowned and non-running runs with 409', async () => {
    await quarantineQueuedRuns();
    const projectId = await seedProject(TEST_USER_ID);
    const testId = await seedTest(projectId, 'claim-guard');
    const r = await seedRun({ projectId, testId, status: 'queued' });
    const reg = await call('POST', '/api/v1/workers/register', EDITOR_ID, { name: uid('w-guard'), capacity: 2 });
    const wid = (reg.json as { id: string }).id;

    const foreign = await call('POST', `/api/v1/workers/${wid}/complete`, EDITOR_ID, { runId: r, status: 'passed' });
    assert.equal(foreign.status, 409);

    await call('POST', `/api/v1/workers/${wid}/heartbeat`, EDITOR_ID); // claims r
    const repeat = await call('POST', `/api/v1/workers/${wid}/complete`, EDITOR_ID, { runId: r, status: 'failed' });
    assert.equal(repeat.status, 200);
    const again = await call('POST', `/api/v1/workers/${wid}/complete`, EDITOR_ID, { runId: r, status: 'passed' });
    assert.equal(again.status, 409, 'terminal run cannot complete twice');
  });

  it('sweep marks stale workers offline and requeues queued claims', async () => {
    const projectId = await seedProject(TEST_USER_ID);
    const testId = await seedTest(projectId, 'stale');
    const reg = await call('POST', '/api/v1/workers/register', EDITOR_ID, { name: uid('w-stale'), capacity: 2 });
    const wid = (reg.json as { id: string }).id;
    const r = await seedRun({ projectId, testId, status: 'queued', workerId: wid });
    await db().worker.update({
      where: { id: wid },
      data: { lastHeartbeatAt: new Date(Date.now() - 600_000) },
    });

    const sweep = await call('POST', '/api/v1/workers/sweep', EDITOR_ID);
    assert.equal(sweep.status, 200);
    const report = sweep.json as { staleWorkers: string[]; releasedRuns: string[] };
    assert.ok(report.staleWorkers.includes(wid));
    assert.ok(report.releasedRuns.includes(r));

    const w = await db().worker.findUnique({ where: { id: wid } });
    assert.equal(w?.status, 'offline');
    const run = await db().run.findUnique({ where: { id: r } });
    assert.equal(run?.workerId, null);
    assert.equal(run?.status, 'queued');

    // Project-scoped audit evidence for the requeue is readable.
    const audit = await call('GET', `/api/v1/projects/${projectId}/audit?action=worker.stale-requeue`, TEST_USER_ID);
    assert.equal(audit.status, 200);
    assert.ok((audit.json as unknown[]).length >= 1);

    // Direct helper honors a custom cutoff too.
    const report2 = await requeueStaleWorkers(new Date(), 60_000);
    assert.ok(Array.isArray(report2.staleWorkers));
  });

  it('deregister goes offline and releases queued claims', async () => {
    const projectId = await seedProject(TEST_USER_ID);
    const testId = await seedTest(projectId, 'dereg');
    const reg = await call('POST', '/api/v1/workers/register', EDITOR_ID, { name: uid('w-dereg'), capacity: 2 });
    const wid = (reg.json as { id: string }).id;
    const r = await seedRun({ projectId, testId, status: 'queued', workerId: wid });
    const res = await call('POST', `/api/v1/workers/${wid}/deregister`, EDITOR_ID);
    assert.equal(res.status, 200);
    assert.equal((res.json as { releasedQueuedRuns: number }).releasedQueuedRuns, 1);
    assert.equal((await db().run.findUnique({ where: { id: r } }))?.workerId, null);
  });
});

describe('analytics', () => {
  it('summary numbers, by-browser, flaky detection, duration trend, history + secret redaction', async () => {
    const projectId = await seedProject(TEST_USER_ID);
    const flakyId = await seedTest(projectId, 'flaky-login');
    const stableId = await seedTest(projectId, 'stable-smoke');
    const secret = `p2-secret-${Date.now()}`;
    await db().variable.create({
      data: { projectId, key: 'P2_PW', valueEncrypted: secret, isSecret: true },
    });
    const now = new Date();
    await seedRun({ projectId, testId: flakyId, status: 'passed', browser: 'chromium', durationMs: 1000, finishedAt: now });
    await seedRun({ projectId, testId: flakyId, status: 'passed', browser: 'firefox', durationMs: 2000, finishedAt: now });
    await seedRun({
      projectId, testId: flakyId, status: 'failed', browser: 'chromium', durationMs: 3000, finishedAt: now,
      errorSummary: `login boom leaked ${secret} end`,
    });
    await seedRun({ projectId, testId: stableId, status: 'passed', browser: 'chromium', durationMs: 500, finishedAt: now });
    await seedRun({ projectId, testId: stableId, status: 'passed', browser: 'chromium', durationMs: 700, finishedAt: now });

    const summary = await call('GET', `/api/v1/projects/${projectId}/analytics/summary?days=30`, TEST_USER_ID);
    assert.equal(summary.status, 200);
    const s = summary.json as {
      totals: { total: number; passed: number; failed: number; cancelled: number };
      passRate: number;
      avgDurationMs: number;
      byBrowser: Record<string, { total: number; passed: number; failed: number }>;
      errorSamples: string[];
    };
    assert.deepEqual(s.totals, { total: 5, passed: 4, failed: 1, cancelled: 0 });
    assert.equal(s.passRate, 0.8);
    assert.equal(s.avgDurationMs, Math.round((1000 + 2000 + 3000 + 500 + 700) / 5));
    assert.equal(s.byBrowser['chromium']?.total, 4);
    assert.equal(s.byBrowser['firefox']?.total, 1);
    assert.ok(s.errorSamples.join('\n').includes('***'), 'secret scrubbed in samples');
    assert.ok(!s.errorSamples.join('\n').includes(secret), 'secret plaintext absent');

    const flaky = await call('GET', `/api/v1/projects/${projectId}/analytics/flaky?runs=20`, TEST_USER_ID);
    assert.equal(flaky.status, 200);
    const rows = (flaky.json as { flaky: Array<{ testId: string; passed: number; failed: number; flakyScore: number }> }).flaky;
    const hit = rows.find((r) => r.testId === flakyId);
    assert.ok(hit, 'mixed pass/fail test detected as flaky');
    assert.deepEqual([hit.passed, hit.failed], [2, 1]);
    assert.ok(!rows.some((r) => r.testId === stableId), 'all-pass test is not flaky');

    const trend = await call('GET', `/api/v1/projects/${projectId}/analytics/duration?days=30`, TEST_USER_ID);
    assert.equal(trend.status, 200);
    const points = (trend.json as { trend: Array<{ runs: number }> }).trend;
    assert.ok(points.length >= 1 && points.reduce((a, p) => a + p.runs, 0) === 5);

    const scoped = await call(
      'GET', `/api/v1/projects/${projectId}/analytics/duration?days=30&testId=${stableId}`, TEST_USER_ID,
    );
    assert.equal((scoped.json as { trend: Array<{ runs: number }> }).trend.reduce((a, p) => a + p.runs, 0), 2);
    const badScope = await call(
      'GET', `/api/v1/projects/${projectId}/analytics/duration?testId=test_nope`, TEST_USER_ID,
    );
    assert.equal(badScope.status, 400);

    const history = await call('GET', `/api/v1/tests/${flakyId}/history?limit=10`, TEST_USER_ID);
    assert.equal(history.status, 200);
    const hruns = (history.json as { runs: Array<{ errorSummary: string | null }> }).runs;
    assert.equal(hruns.length, 3);
    assert.ok(!hruns.map((r) => r.errorSummary ?? '').join('\n').includes(secret));
  });

  it('project viewer may read analytics; non-member is blocked', async () => {
    const projectId = await seedProject(TEST_USER_ID, VIEWER_ID, 'viewer');
    const ok = await call('GET', `/api/v1/projects/${projectId}/analytics/summary`, VIEWER_ID);
    assert.equal(ok.status, 200);
    const denied = await call('GET', `/api/v1/projects/${projectId}/analytics/summary`, OUTSIDER_ID);
    assert.equal(denied.status, 403);
  });
});

describe('audit + RBAC', () => {
  it('writeAudit masks sensitive keys; read filters by action/user', async () => {
    const projectId = await seedProject(TEST_USER_ID, VIEWER_ID, 'viewer');
    await writeAudit({
      projectId,
      userId: TEST_USER_ID,
      action: 'test.p2-probe',
      entityType: 'test',
      entityId: 't1',
      details: { password: 'hunter2', nested: { token: 'abc' }, ok: 'fine' },
    });
    const res = await call('GET', `/api/v1/projects/${projectId}/audit?action=test.p2-probe`, VIEWER_ID);
    assert.equal(res.status, 200);
    const rows = res.json as Array<{ details: string }>;
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.details.includes('***'));
    assert.ok(!rows[0]!.details.includes('hunter2'));
    const byUser = await call(
      'GET', `/api/v1/projects/${projectId}/audit?userId=${TEST_USER_ID}`, VIEWER_ID,
    );
    assert.ok((byUser.json as unknown[]).length >= 1);
    const outsider = await call('GET', `/api/v1/projects/${projectId}/audit`, OUTSIDER_ID);
    assert.equal(outsider.status, 403);
  });

  it('global viewer is blocked from worker writes; tester allowed', async () => {
    const blocked = await call('POST', '/api/v1/workers/register', VIEWER_ID, { name: uid('w-no') });
    assert.equal(blocked.status, 403);
    const sweepBlocked = await call('POST', '/api/v1/workers/sweep', VIEWER_ID);
    assert.equal(sweepBlocked.status, 403);
    const allowed = await call('POST', '/api/v1/workers/register', EDITOR_ID, { name: uid('w-yes') });
    assert.equal(allowed.status, 201);
  });

  it('requireRole: viewer read-only, editor writes, admin bypass, outsider denied', async () => {
    const projectId = await seedProject(TEST_USER_ID, VIEWER_ID, 'viewer');
    await db().projectMember.upsert({
      where: { projectId_userId: { projectId, userId: EDITOR_ID } },
      update: { role: 'editor' },
      create: { projectId, userId: EDITOR_ID, role: 'editor' },
    });
    const req = (id: string): Parameters<typeof requireRole>[0] => ({ user: { id, role: 'x' } }) as never;
    assert.equal(await requireRole(req(VIEWER_ID), projectId, 'viewer'), 'viewer');
    await assert.rejects(() => requireRole(req(VIEWER_ID), projectId, 'editor'), /Requires project role/);
    assert.equal(await requireRole(req(EDITOR_ID), projectId, 'editor'), 'editor');
    assert.equal(await requireRole(req(ADMIN_ID), projectId, 'editor'), 'owner', 'global admin bypass, no membership needed');
    await assert.rejects(() => requireRole(req(OUTSIDER_ID), projectId, 'viewer'), /No access/);
    await assert.rejects(() => requireRole({} as never, projectId, 'viewer'), /Missing credentials/);
  });
});

describe('oidc config (offline validation only — no network)', () => {
  it('validates shape and builds login URLs without network', () => {
    assert.ok(validateOidcConfig({ issuer: '', clientId: '', redirectUri: '' }).length >= 2);
    assert.ok(validateOidcConfig({ issuer: 'http://plain', clientId: 'c', redirectUri: 'https://app/cb' }).length >= 1);
    assert.deepEqual(
      validateOidcConfig({ issuer: 'https://sso.example.com/realm', clientId: 'studio', redirectUri: 'https://app.example.com/cb' }),
      [],
    );
    const url = buildOidcLoginUrl(
      { clientId: 'studio', redirectUri: 'https://app.example.com/cb', scopes: ['openid', 'email'] },
      'https://sso.example.com/authorize',
      'state-123',
      'nonce-456',
    );
    assert.ok(url.includes('client_id=studio') && url.includes('state-123') && url.includes('nonce-456'));

    const def = readOidcConfig({} as NodeJS.ProcessEnv);
    assert.equal(def.enabled, false);

    const payload = { iss: 'https://sso.example.com', sub: 'u1', aud: 'studio' };
    const fake = `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
    assert.deepEqual(decodeJwtPayloadUnsafe(fake).sub, 'u1');
    assert.throws(() => decodeJwtPayloadUnsafe('not-a-jwt'), /malformed JWT/);
  });

  it('status endpoint never exposes the client secret', async () => {
    process.env.OIDC_CLIENT_SECRET = 'super-secret-value';
    try {
      const res = await call('GET', '/api/v1/auth/oidc/status', EDITOR_ID);
      assert.equal(res.status, 200);
      assert.ok(!JSON.stringify(res.json).includes('super-secret-value'));
      assert.equal((res.json as { clientSecretConfigured: boolean }).clientSecretConfigured, true);
    } finally {
      delete process.env.OIDC_CLIENT_SECRET;
    }
  });
});
