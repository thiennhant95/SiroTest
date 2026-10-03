/**
 * Integration: P1 wave-2 run wiring — profiles + upload fileIds flow into
 * runTest from ALL trigger paths (single runs, suite runs).
 *
 * Strategy: validation paths fail fast with 400 (no browser needed);
 * happy paths use tiny waitForTimeout definitions (real browser, deterministic).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ensureIntegrationDb, injectJson } from './helpers.js';

process.env.SKIP_LISTEN = '1';
const { buildApp } = await import('../../apps/server/src/app.js');

let app: FastifyInstance;

before(async () => {
  await ensureIntegrationDb();
  app = await buildApp();
});

after(async () => {
  await app.close();
});

function waitDef(projectId: string) {
  return {
    schemaVersion: '1.0',
    id: 'test_wait_wiring',
    projectId,
    name: 'wait',
    browser: 'chromium',
    steps: [{ id: 's1', type: 'waitForTimeout', enabled: true, milliseconds: 200 }],
  };
}

async function makeProject(name: string): Promise<string> {
  const res = await injectJson(app, 'POST', '/api/v1/projects', { name });
  assert.equal(res.statusCode, 201);
  return (res.json() as { id: string }).id;
}

async function makeEnv(projectId: string): Promise<string> {
  const res = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/environments`, {
    name: 'wiring-env',
    baseUrl: 'http://127.0.0.1:3123',
  });
  assert.equal(res.statusCode, 201);
  return (res.json() as { id: string }).id;
}

async function waitRunTerminal(runId: string, timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const cur = await injectJson(app, 'GET', `/api/v1/runs/${runId}`);
    assert.equal(cur.statusCode, 200);
    const status = (cur.json() as { status: string }).status;
    if (['passed', 'failed', 'cancelled'].includes(status)) return status;
    assert.ok(Date.now() < deadline, `run ${runId} should settle (last: ${status})`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe('run profileId validation (fail fast, no browser)', () => {
  it('rejects unknown, foreign and env-mismatched profiles with 400', async () => {
    const projectId = await makeProject('wiring-profile-proj');
    const otherId = await makeProject('wiring-profile-other');
    const envId = await makeEnv(projectId);
    const testId = (
      await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
        name: 'w',
        definitionJson: waitDef(projectId),
      })
    ).json() as { id: string };

    const unknown = await injectJson(app, 'POST', `/api/v1/tests/${testId.id}/runs`, {
      environmentId: envId,
      profileId: 'auth_nope',
    });
    assert.equal(unknown.statusCode, 400);

    const foreignProfile = (
      await injectJson(app, 'POST', `/api/v1/projects/${otherId}/profiles`, {
        name: 'foreign',
        storageStateJson: { cookies: [], origins: [] },
      })
    ).json() as { id: string };
    const foreign = await injectJson(app, 'POST', `/api/v1/tests/${testId.id}/runs`, {
      environmentId: envId,
      profileId: foreignProfile.id,
    });
    assert.equal(foreign.statusCode, 400);

    const env2 = (
      await injectJson(app, 'POST', `/api/v1/projects/${projectId}/environments`, {
        name: 'wiring-env-2',
        baseUrl: 'http://127.0.0.1:3124',
      })
    ).json() as { id: string };
    const boundProfile = (
      await injectJson(app, 'POST', `/api/v1/projects/${projectId}/profiles`, {
        name: 'bound',
        environmentId: env2.id,
        storageStateJson: { cookies: [], origins: [] },
      })
    ).json() as { id: string };
    const mismatched = await injectJson(app, 'POST', `/api/v1/tests/${testId.id}/runs`, {
      environmentId: envId,
      profileId: boundProfile.id,
    });
    assert.equal(mismatched.statusCode, 400);
  });
});

describe('run with explicit profile (real browser)', () => {
  it('passes a waitForTimeout run with storage state applied', async () => {
    const projectId = await makeProject('wiring-profile-run-proj');
    const envId = await makeEnv(projectId);
    const testId = (
      await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
        name: 'w',
        definitionJson: waitDef(projectId),
      })
    ).json() as { id: string };
    const profileId = (
      await injectJson(app, 'POST', `/api/v1/projects/${projectId}/profiles`, {
        name: 'empty-state',
        environmentId: envId,
        storageStateJson: { cookies: [], origins: [] },
      })
    ).json() as { id: string };

    const started = await injectJson(app, 'POST', `/api/v1/tests/${testId.id}/runs`, {
      environmentId: envId,
      profileId: profileId.id,
    });
    assert.equal(started.statusCode, 202);
    const runId = (started.json() as { id: string }).id;
    assert.equal(await waitRunTerminal(runId), 'passed');
  });
});

describe('upload fileIds wiring', () => {
  it('rejects runs referencing unknown files with 400 (no browser spawned)', async () => {
    const projectId = await makeProject('wiring-files-proj');
    const envId = await makeEnv(projectId);
    const def = {
      ...waitDef(projectId),
      steps: [
        {
          id: 's1',
          type: 'upload',
          enabled: true,
          target: { primary: { strategy: 'label', value: 'File' } },
          fileId: 'file_nope',
        },
      ],
    };
    const testId = (
      await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
        name: 'uploader',
        definitionJson: def,
      })
    ).json() as { id: string };
    const res = await injectJson(app, 'POST', `/api/v1/tests/${testId.id}/runs`, {
      environmentId: envId,
    });
    assert.equal(res.statusCode, 400);
    assert.match((res.json() as { message: string }).message, /upload file resolution failed/);
  });

  it('resolves a real uploaded file into the run (fails on locator, not on files)', async () => {
    const projectId = await makeProject('wiring-files-run-proj');
    const envId = await makeEnv(projectId);
    const uploaded = await injectJson(app, 'POST', `/api/v1/projects/${projectId}/files`, {
      name: 'note.txt',
      contentBase64: Buffer.from('hello studio').toString('base64'),
      mimeType: 'text/plain',
    });
    assert.equal(uploaded.statusCode, 201);
    const fileId = (uploaded.json() as { id: string }).id;
    // Fixture app has no file input: the run must get PAST file resolution
    // and compilation (browser launches, locator fails) — proving filePaths
    // plumbing works end to end.
    const def = {
      ...waitDef(projectId),
      steps: [
        {
          id: 's1',
          type: 'upload',
          enabled: true,
          target: { primary: { strategy: 'label', value: 'No Such File Input' } },
          fileId,
        },
      ],
    };
    const testId = (
      await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
        name: 'uploader',
        definitionJson: def,
      })
    ).json() as { id: string };
    const started = await injectJson(app, 'POST', `/api/v1/tests/${testId.id}/runs`, {
      environmentId: envId,
    });
    assert.equal(started.statusCode, 202);
    const runId = (started.json() as { id: string }).id;
    assert.equal(await waitRunTerminal(runId), 'failed');
    const detail = (await injectJson(app, 'GET', `/api/v1/runs/${runId}`)).json() as {
      steps: Array<{ errorMessage?: string }>;
    };
    const errors = detail.steps.map((s) => s.errorMessage ?? '').join('\n');
    assert.ok(!/upload file resolution failed|filePaths/i.test(errors), `failure must be locator-level, got: ${errors.slice(0, 300)}`);
  });
});

describe('suite run with profileId', () => {
  it('threads the profile into every member run', async () => {
    const projectId = await makeProject('wiring-suite-profile-proj');
    const envId = await makeEnv(projectId);
    const mk = async (name: string) =>
      (
        await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
          name,
          definitionJson: waitDef(projectId),
        })
      ).json() as { id: string };
    const t1 = await mk('p1');
    const profileId = (
      await injectJson(app, 'POST', `/api/v1/projects/${projectId}/profiles`, {
        name: 'suite-state',
        storageStateJson: { cookies: [], origins: [] },
      })
    ).json() as { id: string };
    const sid = (
      await injectJson(app, 'POST', `/api/v1/projects/${projectId}/suites`, { name: 's' })
    ).json() as { id: string };
    await injectJson(app, 'POST', `/api/v1/suites/${sid.id}/tests`, { testId: t1.id });

    const started = await injectJson(app, 'POST', `/api/v1/suites/${sid.id}/runs`, {
      environmentId: envId,
      profileId: profileId.id,
    });
    assert.equal(started.statusCode, 202);
    const suiteRunId = (started.json() as { suiteRunId: string }).suiteRunId;
    const deadline = Date.now() + 90_000;
    for (;;) {
      const cur = await injectJson(app, 'GET', `/api/v1/suite-runs/${suiteRunId}`);
      assert.equal(cur.statusCode, 200);
      const status = (cur.json() as { status: string }).status;
      if (['passed', 'failed', 'cancelled'].includes(status)) {
        assert.equal(status, 'passed');
        break;
      }
      assert.ok(Date.now() < deadline, 'suite should settle');
      await new Promise((r) => setTimeout(r, 1000));
    }
  });
});
