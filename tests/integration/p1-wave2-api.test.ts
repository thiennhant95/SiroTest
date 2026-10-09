/**
 * Integration: P1 wave-2 SERVER APIs — auth profiles, file library,
 * schedules CRUD, project export/import, Playwright spec importer.
 *
 * Strategy: real Fastify app + isolated SQLite file (never dev.db), no
 * browser needed (pure CRUD/parse paths; the one compile check uses the
 * deterministic compiler, not execution).
 *
 * Run: npx tsx --test tests/integration/p1-wave2-api.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  ensureIntegrationDb,
  injectJson,
} from './helpers.js';

process.env.SKIP_LISTEN = '1';
// Deterministic AES-256-GCM key (32 zero bytes) so the encrypt/mask/resolve
// paths are exercised instead of the legacy-plaintext fallback.
process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
const { buildApp } = await import('../../apps/server/src/app.js');
const { db } = await import('../../apps/server/src/db.js');
const { resolveProfileState } = await import('../../apps/server/src/routes/profiles.js');
const { resolveFilePaths, decodeFileBase64ForImport } = await import('../../apps/server/src/routes/files.js');

let app: FastifyInstance;
/** Real HTTP base (ephemeral port): light-my-request decodes bodies as UTF-8,
// so binary downloads are verified through fetch instead of app.inject. */
let httpBase = '';

before(async () => {
  process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'vv-wave2-storage-'));
  await ensureIntegrationDb();
  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('listen failed');
  httpBase = `http://127.0.0.1:${addr.port}`;
});

async function downloadBytes(fid: string): Promise<{ status: number; contentType: string; disposition: string; bytes: Buffer }> {
  const res = await fetch(`${httpBase}/api/v1/files/${fid}/download`, {
    headers: { 'x-user-id': 'u_integration' },
  });
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    disposition: res.headers.get('content-disposition') ?? '',
    bytes: Buffer.from(await res.arrayBuffer()),
  };
}

after(async () => {
  await app.close();
});

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function storageState(cookies: unknown[] = [{ name: 'sid', value: 'abc' }]) {
  return { cookies, origins: [{ origin: 'https://example.com', localStorage: [] }] };
}

async function makeProject(name: string): Promise<string> {
  const res = await injectJson(app, 'POST', '/api/v1/projects', { name });
  assert.equal(res.statusCode, 201);
  return (res.json() as { id: string }).id;
}

async function makeEnv(projectId: string, name = 'wave2-env'): Promise<string> {
  const res = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/environments`, {
    name, baseUrl: 'http://127.0.0.1:3123',
  });
  assert.equal(res.statusCode, 201);
  return (res.json() as { id: string }).id;
}

function waitDef(projectId: string) {
  return {
    schemaVersion: '1.0',
    id: 'test_wave2_wait',
    projectId,
    name: 'wave2 wait',
    browser: 'chromium',
    steps: [{ id: 's1', type: 'waitForTimeout', enabled: true, milliseconds: 50 }],
  };
}

async function makeTest(projectId: string, name: string, definition: unknown): Promise<string> {
  const res = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
    name, definitionJson: definition,
  });
  assert.equal(res.statusCode, 201);
  return (res.json() as { id: string }).id;
}

describe('auth profiles (encrypt/mask/resolve)', () => {
  it('creates masked profiles, rejects bad shapes, resolves decrypted state', async () => {
    const projectId = await makeProject('wave2-profiles');
    const envId = await makeEnv(projectId);

    const created = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/profiles`, {
      name: 'staging-login', environmentId: envId, storageStateJson: storageState(),
    });
    assert.equal(created.statusCode, 201);
    const body = created.json() as Record<string, unknown>;
    assert.equal(body['hasValue'], true);
    assert.ok(!('stateEncrypted' in body), 'ciphertext column never leaves the server');
    assert.ok(!JSON.stringify(body).includes('abc'), 'plaintext cookie never echoed');
    const pid = body['id'] as string;

    // At rest the cell is AES-256-GCM ciphertext (key configured above).
    const row = await db().authProfile.findUnique({ where: { id: pid } });
    assert.match(row!.stateEncrypted, /^enc:v1:/);

    // Runner helper decrypts; env-scoped wins, unknown project → null.
    const resolved = await resolveProfileState(projectId, envId);
    assert.deepEqual((resolved as { cookies: unknown[] }).cookies, [{ name: 'sid', value: 'abc' }]);
    assert.equal(await resolveProfileState('project_nope', envId), null);

    // Env-agnostic fallback applies when no exact match exists.
    await injectJson(app, 'POST', `/api/v1/projects/${projectId}/profiles`, {
      name: 'global-login', storageStateJson: storageState([{ name: 'sid', value: 'global' }]),
    });
    const fallback = await resolveProfileState(projectId, 'env_nope') as { cookies: Array<{ value: string }> };
    assert.equal(fallback.cookies[0]!.value, 'global');

    // Reads stay masked.
    const listed = (await injectJson(app, 'GET', `/api/v1/projects/${projectId}/profiles`)).json() as unknown[];
    assert.equal(listed.length, 2);
    assert.ok(!JSON.stringify(listed).includes('abc'));

    const patched = await injectJson(app, 'PATCH', `/api/v1/profiles/${pid}`, { name: 'staging-login-2' });
    assert.equal(patched.statusCode, 200);
    assert.equal((patched.json() as { name: string }).name, 'staging-login-2');

    const deleted = await injectJson(app, 'DELETE', `/api/v1/profiles/${pid}`);
    assert.equal(deleted.statusCode, 204);
    assert.equal((await injectJson(app, 'GET', `/api/v1/profiles/${pid}`)).statusCode, 404);
  });

  it('rejects non-storageState shapes with explicit 400', async () => {
    const projectId = await makeProject('wave2-profiles-bad');
    for (const bad of [
      { name: 'x', storageStateJson: { foo: 1 } },
      { name: 'x', storageStateJson: { cookies: 'nope', origins: [] } },
      { name: 'x', storageStateJson: 'not-json{{{' },
      { name: 'x', storageStateJson: [1, 2] },
    ]) {
      const res = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/profiles`, bad);
      assert.equal(res.statusCode, 400, JSON.stringify(bad));
      assert.equal((res.json() as { code: string }).code, 'VALIDATION_ERROR');
    }
    const foreign = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/profiles`, {
      name: 'x', environmentId: 'env_nope', storageStateJson: storageState(),
    });
    assert.equal(foreign.statusCode, 400);
  });
});

describe('file library (upload/download/in-use)', () => {
  it('uploads, lists metadata-only, downloads identical bytes', async () => {
    const projectId = await makeProject('wave2-files');
    const up = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/files`, {
      name: 'logo.png', contentBase64: PNG_BYTES.toString('base64'), mimeType: 'image/png',
    });
    assert.equal(up.statusCode, 201);
    const meta = up.json() as { id: string; sizeBytes: number; path: string };
    assert.equal(meta.sizeBytes, PNG_BYTES.length);
    assert.match(meta.path, /^files\//);
    assert.ok(!meta.path.startsWith('/'), 'storage-relative path only');
    assert.ok(!('contentBase64' in (up.json() as object)));
    const fid = meta.id;

    const listed = (await injectJson(app, 'GET', `/api/v1/projects/${projectId}/files`)).json() as unknown[];
    assert.equal(listed.length, 1);
    assert.ok(!JSON.stringify(listed).includes('contentBase64'));

    const dl = await downloadBytes(fid);
    assert.equal(dl.status, 200);
    assert.match(dl.contentType, /image\/png/);
    assert.match(dl.disposition, /logo\.png/);
    assert.equal(Buffer.compare(dl.bytes, PNG_BYTES), 0);

    const resolved = await resolveFilePaths(projectId, [fid]);
    assert.ok(resolved.paths[fid]!.endsWith(`${fid}-logo.png`));
    assert.equal(resolved.names[fid], 'logo.png');
    await assert.rejects(() => resolveFilePaths(projectId, ['file_nope']), /not found/);

    assert.equal((await injectJson(app, 'DELETE', `/api/v1/files/${fid}`)).statusCode, 204);
    const afterDelete = (await injectJson(app, 'GET', `/api/v1/projects/${projectId}/files`)).json() as unknown[];
    assert.equal(afterDelete.length, 0);
  });

  it('sanitizes names, checks magic, and blocks deletes of referenced files', async () => {
    const projectId = await makeProject('wave2-files-guard');

    const traversal = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/files`, {
      name: '../../evil.png', contentBase64: PNG_BYTES.toString('base64'), mimeType: 'image/png',
    });
    assert.equal(traversal.statusCode, 201);
    assert.equal((traversal.json() as { name: string }).name, 'evil.png');
    const fid = (traversal.json() as { id: string }).id;

    const mismatch = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/files`, {
      name: 'a.jpg', contentBase64: PNG_BYTES.toString('base64'), mimeType: 'image/jpeg',
    });
    // jpeg family accepts any image/* per the light check — png bytes do not.
    assert.equal(mismatch.statusCode, 400);

    const badB64 = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/files`, {
      name: 'a.bin', contentBase64: '!!!not-base64!!!',
    });
    assert.equal(badB64.statusCode, 400);

    const badName = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/files`, {
      name: '///', contentBase64: PNG_BYTES.toString('base64'),
    });
    assert.equal(badName.statusCode, 400);

    // Reference the file from a test definition → DELETE is 409 FILE_IN_USE.
    const tid = await makeTest(projectId, 'uploading test', {
      ...waitDef(projectId),
      steps: [{
        id: 's1', type: 'click', enabled: true,
        target: { primary: { strategy: 'label', value: 'Upload' } },
        fileId: fid,
      }],
    });
    const blocked = await injectJson(app, 'DELETE', `/api/v1/files/${fid}`);
    assert.equal(blocked.statusCode, 409);
    assert.equal((blocked.json() as { code: string }).code, 'FILE_IN_USE');
    assert.deepEqual((blocked.json() as { details: { testIds: string[] } }).details.testIds, [tid]);

    assert.equal((await injectJson(app, 'DELETE', `/api/v1/tests/${tid}`)).statusCode, 204);
    assert.equal((await injectJson(app, 'DELETE', `/api/v1/files/${fid}`)).statusCode, 204);
    assert.equal((await injectJson(app, 'DELETE', '/api/v1/files/file_nope')).statusCode, 404);
  });

  it('enforces the 10 MB/file cap in the base64 decoder', () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 7).toString('base64');
    assert.throws(() => decodeFileBase64ForImport(big, 'big.bin'), /max/);
  });
});

describe('schedules CRUD + validation (no ticker)', () => {
  async function fixture() {
    const projectId = await makeProject(`wave2-sched-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const envId = await makeEnv(projectId);
    const testId = await makeTest(projectId, 'sched-t', waitDef(projectId));
    const suiteRes = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/suites`, { name: 'sched-suite' });
    const suiteId = (suiteRes.json() as { id: string }).id;
    return { projectId, envId, testId, suiteId };
  }

  it('creates, reads, patches, lists, deletes; history filters trigger=schedule', async () => {
    const { projectId, envId, testId, suiteId } = await fixture();

    const created = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/schedules`, {
      suiteId, environmentId: envId, cron: '*/15 * * * *', retries: 2,
    });
    assert.equal(created.statusCode, 201);
    const sched = created.json() as { id: string; enabled: boolean; retries: number; lastRunAt: null; nextRunAt: null };
    assert.equal(sched.enabled, true);
    assert.equal(sched.retries, 2);
    assert.equal(sched.lastRunAt, null);
    assert.equal(sched.nextRunAt, null);

    const got = await injectJson(app, 'GET', `/api/v1/schedules/${sched.id}`);
    assert.equal(got.statusCode, 200);

    const patched = await injectJson(app, 'PATCH', `/api/v1/schedules/${sched.id}`, {
      cron: '0 9 * * 1', enabled: false,
    });
    assert.equal(patched.statusCode, 200);
    assert.equal((patched.json() as { cron: string }).cron, '0 9 * * 1');

    // Re-target to a single test (exactly-one rule clears the suite side).
    const retarget = await injectJson(app, 'PATCH', `/api/v1/schedules/${sched.id}`, { testId });
    assert.equal(retarget.statusCode, 200);
    assert.equal((retarget.json() as { suiteId: null }).suiteId, null);

    // History: only trigger='schedule' rows for this target show up.
    const run = await db().run.create({
      data: { projectId, testId, environmentId: envId, status: 'passed', trigger: 'schedule' },
    });
    await db().run.create({
      data: { projectId, testId, environmentId: envId, status: 'passed', trigger: 'manual' },
    });
    const hist = (await injectJson(app, 'GET', `/api/v1/schedules/${sched.id}/runs`)).json() as Array<{ id: string }>;
    assert.deepEqual(hist.map((r) => r.id), [run.id]);

    const listed = (await injectJson(app, 'GET', `/api/v1/projects/${projectId}/schedules`)).json() as unknown[];
    assert.equal(listed.length, 1);
    assert.equal((await injectJson(app, 'DELETE', `/api/v1/schedules/${sched.id}`)).statusCode, 204);
    assert.equal((await injectJson(app, 'GET', `/api/v1/schedules/${sched.id}`)).statusCode, 404);
  });

  it('validates targets, envs, cron ranges, and duplicate enabled schedules', async () => {
    const { projectId, envId, testId, suiteId } = await fixture();
    const good = { suiteId, environmentId: envId, cron: '0 8 * * *' };

    const both = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/schedules`, { ...good, testId });
    assert.equal(both.statusCode, 400);
    const neither = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/schedules`, {
      environmentId: envId, cron: '0 8 * * *',
    });
    assert.equal(neither.statusCode, 400);

    for (const cron of ['* * * *', '99 * * * *', '*/x * * * *', '0 25 * * *', '0 0 0 * *', '0 0 * 13 *', '0 0 * * 8', 'mon-fri * * *']) {
      const res = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/schedules`, {
        suiteId, environmentId: envId, cron,
      });
      assert.equal(res.statusCode, 400, cron);
      assert.equal((res.json() as { code: string }).code, 'CRON_INVALID');
    }
    // Rich but valid shapes pass the 5-field range check.
    const fancy = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/schedules`, {
      suiteId, environmentId: envId, cron: '*/10 9-17 * * 1-5',
    });
    assert.equal(fancy.statusCode, 201);
    const fancyId = (fancy.json() as { id: string }).id;

    const badEnv = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/schedules`, {
      suiteId, environmentId: 'env_nope', cron: '0 8 * * *',
    });
    assert.equal(badEnv.statusCode, 400);

    // Identical enabled schedule → 409 SCHEDULE_CONFLICT; disabled twin is fine.
    const first = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/schedules`, good);
    assert.equal(first.statusCode, 201);
    const dup = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/schedules`, good);
    assert.equal(dup.statusCode, 409);
    assert.equal((dup.json() as { code: string }).code, 'SCHEDULE_CONFLICT');
    const disabledTwin = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/schedules`, {
      ...good, enabled: false,
    });
    assert.equal(disabledTwin.statusCode, 201);

    const badPatch = await injectJson(app, 'PATCH', `/api/v1/schedules/${fancyId}`, { cron: 'nope' });
    assert.equal(badPatch.statusCode, 400);
    assert.equal((await injectJson(app, 'GET', '/api/v1/schedules/sched_nope')).statusCode, 404);
  });
});

describe('project export/import roundtrip', () => {
  async function fullProject(name: string) {
    const projectId = await makeProject(name);
    const envId = await makeEnv(projectId);
    const plain = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/variables`, {
      key: 'API_URL', value: 'https://api.example.com',
    });
    assert.equal(plain.statusCode, 201);
    const secret = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/variables`, {
      key: 'API_TOKEN', value: 'tok-super-secret', isSecret: true,
    });
    assert.equal(secret.statusCode, 201);

    const fileRes = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/files`, {
      name: 'data.png', contentBase64: PNG_BYTES.toString('base64'), mimeType: 'image/png',
    });
    const fileId = (fileRes.json() as { id: string }).id;

    const actionRes = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/actions`, {
      name: 'open-home',
      steps: [{ id: 'a1', type: 'goto', enabled: true, url: 'http://127.0.0.1:3123/' }],
    });
    assert.equal(actionRes.statusCode, 201);
    const actionId = (actionRes.json() as { id: string }).id;

    const testId = await makeTest(projectId, 'full test', {
      ...waitDef(projectId),
      steps: [
        { id: 's1', type: 'callAction', enabled: true, actionId },
        {
          id: 's2', type: 'click', enabled: true,
          target: { primary: { strategy: 'label', value: 'Upload' } }, fileId,
        },
      ],
    });
    const suiteRes = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/suites`, { name: 'full suite' });
    const suiteId = (suiteRes.json() as { id: string }).id;
    assert.equal((await injectJson(app, 'POST', `/api/v1/suites/${suiteId}/tests`, { testId })).statusCode, 201);
    const schedRes = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/schedules`, {
      suiteId, environmentId: envId, cron: '30 7 * * *',
    });
    assert.equal(schedRes.statusCode, 201);
    return { projectId, envId, testId, suiteId, actionId, fileId };
  }

  it('exports portable JSON (secrets blank) and re-imports with fresh ids', async () => {
    const src = await fullProject('wave2-export-src');

    const badFormat = await injectJson(app, 'GET', `/api/v1/projects/${src.projectId}/export?format=xml`);
    assert.equal(badFormat.statusCode, 400);

    const exp = await injectJson(app, 'GET', `/api/v1/projects/${src.projectId}/export?format=json`);
    assert.equal(exp.statusCode, 200);
    const payload = exp.json() as {
      version: number;
      variables: Array<{ key: string; isSecret: boolean; value?: string; hasValue?: boolean }>;
      files: Array<{ contentBase64: string }>;
      tests: unknown[];
    };
    assert.equal(payload.version, 1);
    const token = payload.variables.find((v) => v.key === 'API_TOKEN')!;
    assert.equal(token.isSecret, true);
    assert.ok(!('value' in token), 'secret values never travel in exports');
    assert.equal(token.hasValue, true);
    assert.equal(payload.variables.find((v) => v.key === 'API_URL')!.value, 'https://api.example.com');
    assert.ok(!JSON.stringify(payload).includes('tok-super-secret'));
    assert.equal(payload.files.length, 1);

    const imp = await injectJson(app, 'POST', '/api/v1/projects/import', {
      name: 'wave2-export-dst', payload,
    });
    assert.equal(imp.statusCode, 201);
    const { project, counts } = imp.json() as { project: { id: string }; counts: Record<string, number> };
    assert.notEqual(project.id, src.projectId);
    assert.deepEqual(counts, {
      environments: 1, variables: 2, tests: 1, actions: 1, suites: 1, schedules: 1, files: 1,
    });

    // Fresh ids everywhere, same shape.
    const dstTests = (await injectJson(app, 'GET', `/api/v1/projects/${project.id}/tests`)).json() as Array<{ id: string; name: string }>;
    assert.equal(dstTests.length, 1);
    assert.notEqual(dstTests[0]!.id, src.testId);
    const dstDef = JSON.parse((await db().test.findUnique({ where: { id: dstTests[0]!.id } }))!.definitionJson) as {
      projectId: string; steps: Array<{ actionId?: string; fileId?: string }>;
    };
    assert.equal(dstDef.projectId, project.id);
    const dstActionId = (await db().action.findFirst({ where: { projectId: project.id } }))!.id;
    assert.notEqual(dstActionId, src.actionId);
    assert.equal(dstDef.steps[0]!.actionId, dstActionId, 'callAction rewritten to the new action id');
    const dstFileId = (await db().fileAsset.findFirst({ where: { projectId: project.id } }))!.id;
    assert.notEqual(dstFileId, src.fileId);
    assert.equal(dstDef.steps[1]!.fileId, dstFileId, 'fileId rewritten to the new file id');

    // Secrets import blank (user refills); plain values survive.
    const dstVars = (await injectJson(app, 'GET', `/api/v1/projects/${project.id}/variables`)).json() as Array<{
      key: string; isSecret: boolean; value: string | null;
    }>;
    assert.equal(dstVars.find((v) => v.key === 'API_TOKEN')!.value, null);
    assert.equal(dstVars.find((v) => v.key === 'API_URL')!.value, 'https://api.example.com');

    // Version history restarts at 1.
    const versions = await db().testVersion.findMany({ where: { testId: dstTests[0]!.id } });
    assert.deepEqual(versions.map((v) => v.versionNumber), [1]);

    // Suites + schedules point at the remapped rows; file bytes survive.
    const dstSuiteId = (await db().testSuite.findFirst({ where: { projectId: project.id } }))!.id;
    assert.notEqual(dstSuiteId, src.suiteId);
    const members = await db().suiteTest.findMany({ where: { suiteId: dstSuiteId } });
    assert.deepEqual(members.map((m) => m.testId), [dstTests[0]!.id]);
    const dstSched = await db().schedule.findFirst({ where: { projectId: project.id } });
    assert.equal(dstSched!.suiteId, dstSuiteId);
    const dl = await downloadBytes(dstFileId);
    assert.equal(dl.status, 200);
    assert.equal(Buffer.compare(dl.bytes, PNG_BYTES), 0);

    // Name conflict (payload name still taken by the source) → " (imported)".
    const again = await injectJson(app, 'POST', '/api/v1/projects/import', { payload });
    assert.equal(again.statusCode, 201);
    assert.match((again.json() as { project: { name: string } }).project.name, /\(imported/);
  });

  it('fails explicitly on invalid payloads', async () => {
    const empty = await injectJson(app, 'POST', '/api/v1/projects/import', {
      payload: { version: 1 },
    });
    assert.equal(empty.statusCode, 400);
    const badRef = await injectJson(app, 'POST', '/api/v1/projects/import', {
      payload: {
        version: 1,
        project: { name: 'bad' },
        environments: [],
        variables: [],
        tests: [],
        actions: [],
        suites: [{ id: 's1', name: 's', testIds: ['test_nope'] }],
        schedules: [],
        files: [],
      },
    });
    assert.equal(badRef.statusCode, 400);
  });
});

describe('spec importer (feasible subset + warnings)', () => {
  const CODE = [
    "import { test, expect } from '@playwright/test';",
    "test('login works', async ({ page }) => {",
    "  await page.goto('https://example.com/login');",
    "  await test.step('fill form', async () => {",
    "    await page.getByLabel('Email').fill('a@b.c');",
    "    await page.getByRole('button', { name: 'Submit' }).click();",
    '  });',
    "  await expect(page.getByText('Welcome')).toBeVisible();",
    "  await expect(page).toHaveURL('https://example.com/home');",
    "  await page.locator('.unsupported').click();",
    '  const x = 1;',
    '});',
  ].join('\n');

  it('maps the subset, warns on the rest, stores a draft that compiles', async () => {
    const projectId = await makeProject('wave2-importer');
    const res = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/import-spec`, { code: CODE });
    assert.equal(res.statusCode, 201);
    const { test, warnings } = res.json() as {
      test: { id: string; name: string; status: string; definitionJson: { steps: Array<{ type: string }> } };
      warnings: Array<{ line: number; text: string }>;
    };
    assert.equal(test.name, 'login works');
    assert.equal(test.status, 'draft');
    assert.deepEqual(
      test.definitionJson.steps.map((s) => s.type),
      ['goto', 'fill', 'click', 'assertVisible', 'assertURL'],
    );
    assert.equal(warnings.length, 2);
    assert.deepEqual(warnings.map((w) => w.line), [10, 11]);

    // The draft is a real definition: the canonical compiler accepts it.
    const compiled = await injectJson(app, 'POST', `/api/v1/tests/${test.id}/compile`, {});
    assert.equal(compiled.statusCode, 200);
    assert.match((compiled.json() as { code: string }).code, /page\.goto\('https:\/\/example\.com\/login'\)/);
  });

  it('covers the wider subset (roles/placeholder/testId/select/press/expects)', async () => {
    const projectId = await makeProject('wave2-importer-2');
    const code = [
      "test('wide', async ({ page }) => {",
      "  await page.getByPlaceholder('Search').fill('shoes');",
      "  await page.getByPlaceholder('Search').press('Enter');",
      "  await page.getByTestId('country').selectOption('VN');",
      "  await page.getByRole('checkbox').check();",
      "  await page.getByText('More').dblclick();",
      "  await page.getByLabel('Bio').hover();",
      "  await expect(page.getByLabel('Bio')).toHaveText('hello');",
      "  await expect(page.getByLabel('Bio')).toContainText('ell');",
      "  await expect(page.getByLabel('Bio')).toHaveValue('hello');",
      "  await expect(page).toHaveTitle('Shop');",
      '});',
    ].join('\n');
    const res = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/import-spec`, { code, name: 'wide import' });
    assert.equal(res.statusCode, 201);
    const { test, warnings } = res.json() as {
      test: { name: string; definitionJson: { steps: Array<Record<string, unknown>> } };
      warnings: unknown[];
    };
    assert.equal(test.name, 'wide import');
    assert.equal(warnings.length, 0);
    assert.deepEqual(
      (test.definitionJson.steps as Array<{ type: string }>).map((s) => s.type),
      ['fill', 'press', 'select', 'check', 'doubleClick', 'hover', 'assertText', 'assertContainsText', 'assertValue', 'assertTitle'],
    );
  });

  it('returns 422 when nothing maps', async () => {
    const projectId = await makeProject('wave2-importer-3');
    const res = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/import-spec`, {
      code: 'hello world {{{',
    });
    assert.equal(res.statusCode, 422);
    assert.equal((res.json() as { code: string }).code, 'SPEC_NO_STEPS');
    const empty = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/import-spec`, { code: '' });
    assert.equal(empty.statusCode, 400);
  });
});
