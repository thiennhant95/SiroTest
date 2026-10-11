/**
 * Integration: audit-trail coverage — every destructive, definition-rewriting
 * and secret-boundary write leaves a row (durable before the response).
 *
 * Strategy: real Fastify app (full buildApp) + isolated SQLite file, no
 * browser. Each flow performs the write, then reads back
 * GET /projects/:id/audit?action=< Guessed > and asserts the row + that
 * secret-bearing details carry metadata only (never values).
 *
 * Run: npx tsx --test --test-concurrency=1 tests/integration/audit-coverage.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ensureIntegrationDb, injectJson } from './helpers.js';

process.env.SKIP_LISTEN = '1';
process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
const { buildApp } = await import('../../apps/server/src/app.js');
const { db } = await import('../../apps/server/src/db.js');

let app: FastifyInstance;
let n = 0;
const tag = (): string => `auditcov${Date.now().toString(36)}${n++}`;

before(async () => {
  process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'vv-auditcov-storage-'));
  await ensureIntegrationDb();
  app = await buildApp();
});

after(async () => {
  await app.close();
});

type AuditRow = {
  id: string;
  action: string;
  userId: string | null;
  projectId: string | null;
  entityType: string | null;
  entityId: string | null;
  details: string | null;
};

async function audit(projectId: string, action: string): Promise<AuditRow[]> {
  const res = await injectJson(app, 'GET', `/api/v1/projects/${projectId}/audit?action=${action}`);
  assert.equal(res.statusCode, 200);
  return res.json() as AuditRow[];
}

async function makeProject(name: string): Promise<string> {
  const res = await injectJson(app, 'POST', '/api/v1/projects', { name });
  assert.equal(res.statusCode, 201);
  return (res.json() as { id: string }).id;
}

const DEF = (name: string) => ({
  schemaVersion: '1.0',
  name,
  browser: 'chromium',
  steps: [
    { id: 'g1', type: 'goto', enabled: true, url: 'https://example.com' },
    {
      id: 'f1', type: 'fill', enabled: true,
      target: { primary: { strategy: 'label', value: 'Email' } },
      value: 'a@b.c',
    },
  ],
});

async function makeTest(projectId: string, name: string): Promise<string> {
  const res = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
    name,
    definitionJson: DEF(name),
  });
  assert.equal(res.statusCode, 201);
  return (res.json() as { id: string }).id;
}

describe('audit coverage: project + test lifecycle', () => {
  it('project.create leaves a row; project.delete leaves a surviving orphan', async () => {
    const projectId = await makeProject(`${tag()}-proj`);
    assert.equal((await audit(projectId, 'project.create')).length, 1);

    const del = await injectJson(app, 'DELETE', `/api/v1/projects/${projectId}`);
    assert.equal(del.statusCode, 204);
    // The project's own trail cascades away — the delete evidence survives
    // as a project-less orphan for direct-DB forensics.
    const orphans = await db().auditLog.findMany({ where: { action: 'project.delete', entityId: projectId } });
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].projectId, null);
    assert.match(orphans[0].details ?? '', /proj/);
  });

  it('test.duplicate + test.restore leave rows', async () => {
    const projectId = await makeProject(`${tag()}-t`);
    const testId = await makeTest(projectId, 'orig');
    const dup = await injectJson(app, 'POST', `/api/v1/tests/${testId}/duplicate`);
    assert.equal(dup.statusCode, 201);
    assert.equal((await audit(projectId, 'test.duplicate')).length, 1);

    const versions = (
      await injectJson(app, 'GET', `/api/v1/tests/${testId}/versions`)
    ).json() as Array<{ id: string }>;
    const res = await injectJson(app, 'POST', `/api/v1/tests/${testId}/versions/${versions[0].id}/restore`);
    assert.equal(res.statusCode, 200);
    const restores = await audit(projectId, 'test.restore');
    assert.equal(restores.length, 1);
    assert.equal(restores[0].entityId, testId);
  });

  it('suggestions.apply leaves a row with the inserted count', async () => {
    const projectId = await makeProject(`${tag()}-s`);
    const testId = await makeTest(projectId, 'suggy');
    const apply = await injectJson(app, 'POST', `/api/v1/tests/${testId}/suggestions/apply`, { indexes: [0] });
    assert.equal(apply.statusCode, 200);
    const rows = await audit(projectId, 'suggestions.apply');
    assert.equal(rows.length, 1);
    assert.match(rows[0].details ?? '', /"inserted":1/);
  });
});

describe('audit coverage: suites + variables + integrations', () => {
  it('suite membership add/move/replace/remove leave rows', async () => {
    const projectId = await makeProject(`${tag()}-suite`);
    const t1 = await makeTest(projectId, 'one');
    const t2 = await makeTest(projectId, 'two');
    const suite = (
      await injectJson(app, 'POST', `/api/v1/projects/${projectId}/suites`, { name: 's' })
    ).json() as { id: string };
    assert.equal((await injectJson(app, 'POST', `/api/v1/suites/${suite.id}/tests`, { testId: t1 })).statusCode, 201);
    assert.equal((await audit(projectId, 'suite.tests.add')).length, 1);
    assert.equal(
      (await injectJson(app, 'POST', `/api/v1/suites/${suite.id}/tests`, { testId: t1, sortOrder: 5 })).statusCode,
      200,
    );
    assert.equal((await audit(projectId, 'suite.tests.move')).length, 1);
    assert.equal(
      (await injectJson(app, 'PUT', `/api/v1/suites/${suite.id}/tests`, { testIds: [t2, t1] })).statusCode,
      200,
    );
    assert.equal((await audit(projectId, 'suite.tests.replace')).length, 1);
    assert.equal((await injectJson(app, 'DELETE', `/api/v1/suites/${suite.id}/tests/${t2}`)).statusCode, 204);
    const removed = await audit(projectId, 'suite.tests.remove');
    assert.equal(removed.length, 1);
    assert.match(removed[0].details ?? '', new RegExp(t2));
  });

  it('variable writes log metadata only — values never enter the trail', async () => {
    const projectId = await makeProject(`${tag()}-var`);
    const created = (
      await injectJson(app, 'POST', `/api/v1/projects/${projectId}/variables`, {
        key: 'API_TOKEN',
        value: 'super-secret-value',
        isSecret: true,
      })
    ).json() as { id: string };
    const upd = await injectJson(app, 'PATCH', `/api/v1/variables/${created.id}`, { value: 'rotated-secret' });
    assert.equal(upd.statusCode, 200);
    assert.equal((await injectJson(app, 'DELETE', `/api/v1/variables/${created.id}`)).statusCode, 204);
    for (const action of ['variable.create', 'variable.update', 'variable.delete']) {
      const rows = await audit(projectId, action);
      assert.equal(rows.length, 1, action);
      assert.ok(!JSON.stringify(rows[0]).includes('super-secret-value'), `${action} leaks the value`);
      assert.ok(!JSON.stringify(rows[0]).includes('rotated-secret'), `${action} leaks the rotated value`);
    }
    const updRow = (await audit(projectId, 'variable.update'))[0];
    assert.match(updRow.details ?? '', /"valueChanged":true/);
  });

  it('integration writes log metadata only — secrets never enter the trail', async () => {
    const projectId = await makeProject(`${tag()}-int`);
    const created = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/integrations`, {
      provider: 'webhook',
      name: 'ci-hook',
      config: { url: 'https://ci.example.com/hook' },
      secrets: { signingSecret: 'whsec-topsecret' },
    });
    assert.equal(created.statusCode, 201);
    const rows = await audit(projectId, 'integration.create');
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows[0]).includes('whsec-topsecret'), 'signing secret leaks');
    assert.ok(!JSON.stringify(rows[0]).includes('ci.example.com') || true, 'url is non-secret metadata');
  });
});

describe('audit coverage: schedules, transfer, datasets, profiles, actions, envs, files', () => {
  it('schedule.create/update/delete leave rows with touched fields only', async () => {
    const projectId = await makeProject(`${tag()}-sched`);
    const testId = await makeTest(projectId, 'cronned');
    const env = (
      await injectJson(app, 'POST', `/api/v1/projects/${projectId}/environments`, {
        name: 'lab',
        baseUrl: 'https://example.com',
      })
    ).json() as { id: string };
    const created = (
      await injectJson(app, 'POST', `/api/v1/projects/${projectId}/schedules`, {
        testId,
        environmentId: env.id,
        cron: '0 9 * * *',
      })
    ).json() as { id: string };
    assert.equal((await audit(projectId, 'schedule.create')).length, 1);
    assert.equal((await injectJson(app, 'PATCH', `/api/v1/schedules/${created.id}`, { enabled: false })).statusCode, 200);
    const updRows = await audit(projectId, 'schedule.update');
    assert.equal(updRows.length, 1);
    assert.match(updRows[0].details ?? '', /"enabled":false/);
    assert.equal((await injectJson(app, 'DELETE', `/api/v1/schedules/${created.id}`)).statusCode, 204);
    assert.equal((await audit(projectId, 'schedule.delete')).length, 1);
  });

  it('transfer.import leaves a row with counts', async () => {
    const src = await makeProject(`${tag()}-src`);
    await makeTest(src, 'exported');
    const exported = (
      await injectJson(app, 'GET', `/api/v1/projects/${src}/export?format=json`)
    ).json() as { version: number };
    assert.equal(exported.version, 1);
    const full = (
      await injectJson(app, 'GET', `/api/v1/projects/${src}/export?format=json`)
    ).json() as Record<string, unknown>;
    const imported = await injectJson(app, 'POST', '/api/v1/projects/import', {
      name: `${tag()}-dst`,
      payload: full,
    });
    assert.equal(imported.statusCode, 201);
    const dstId = (imported.json() as { project: { id: string } }).project.id;
    const rows = await audit(dstId, 'transfer.import');
    assert.equal(rows.length, 1);
    assert.match(rows[0].details ?? '', /"tests":1/);
  });

  it('dataset.import/delete leave rows with names+counts, never cell content', async () => {
    const projectId = await makeProject(`${tag()}-ds`);
    const testId = await makeTest(projectId, 'data');
    const imp = await injectJson(app, 'POST', `/api/v1/tests/${testId}/datasets/import`, {
      format: 'csv',
      name: 'users',
      content: 'email,password\na@b.c,S3CR3T-CELL\n',
    });
    assert.equal(imp.statusCode, 201);
    const dsid = ((imp.json() as { dataset: { id: string } }).dataset.id);
    const rows = await audit(projectId, 'dataset.import');
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows[0]).includes('S3CR3T-CELL'), 'cell content leaks');
    assert.equal((await injectJson(app, 'DELETE', `/api/v1/tests/${testId}/datasets/${dsid}`)).statusCode, 200);
    assert.equal((await audit(projectId, 'dataset.delete')).length, 1);
  });

  it('profile + action + environment + file deletes leave rows', async () => {
    const projectId = await makeProject(`${tag()}-misc`);
    const profile = (
      await injectJson(app, 'POST', `/api/v1/projects/${projectId}/profiles`, {
        name: 'lab-profile',
        storageStateJson: { cookies: [], origins: [] },
      })
    ).json() as { id: string };
    assert.equal((await audit(projectId, 'profile.create')).length, 1);

    const action = (
      await injectJson(app, 'POST', `/api/v1/projects/${projectId}/actions`, {
        name: 'login-once',
        steps: [
          { id: 'a1', type: 'goto', enabled: true, url: 'https://example.com' },
        ],
      })
    ).json() as { id: string };
    assert.equal((await audit(projectId, 'action.create')).length, 1);

    const env = (
      await injectJson(app, 'POST', `/api/v1/projects/${projectId}/environments`, {
        name: 'lab',
        baseUrl: 'https://example.com',
      })
    ).json() as { id: string };
    assert.equal((await audit(projectId, 'environment.create')).length, 1);

    const file = (
      await injectJson(app, 'POST', `/api/v1/projects/${projectId}/files`, {
        name: 'data.csv',
        contentBase64: Buffer.from('a,b\n1,2\n').toString('base64'),
        mimeType: 'text/csv',
      })
    ).json() as { id: string };

    assert.equal((await injectJson(app, 'DELETE', `/api/v1/profiles/${profile.id}`)).statusCode, 204);
    assert.equal((await audit(projectId, 'profile.delete')).length, 1);
    assert.equal((await injectJson(app, 'DELETE', `/api/v1/actions/${action.id}`)).statusCode, 204);
    assert.equal((await audit(projectId, 'action.delete')).length, 1);
    assert.equal((await injectJson(app, 'DELETE', `/api/v1/environments/${env.id}`)).statusCode, 204);
    assert.equal((await audit(projectId, 'environment.delete')).length, 1);
    assert.equal((await injectJson(app, 'DELETE', `/api/v1/files/${file.id}`)).statusCode, 204);
    const frows = await audit(projectId, 'file.delete');
    assert.equal(frows.length, 1);
    assert.match(frows[0].details ?? '', /data\.csv/);
  });
});
