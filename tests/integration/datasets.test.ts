/**
 * Integration: P1 CSV/JSON/table data sets — data-driven runs.
 * Strategy: 12-testing/test-strategy.md (Integration: API CRUD + run
 * lifecycle with stubbed Playwright, no browser required).
 *
 * Covers:
 * - POST /tests/:id/datasets/import (CSV quotes/commas/newlines, JSON,
 *   validation errors, 500-row cap) + DELETE /tests/:id/datasets/:dsid.
 * - POST /tests/:id/runs dataset validation (unknown id, bad rowIndex,
 *   rowIndex-without-dataset) + persistence of datasetId/rowIndex.
 * - POST /tests/:id/compile + GET export with datasetId (loop preview).
 * - Runner runTest with dataset via stub (VV_DATASET_ROWS injection,
 *   single-row mode, invalid selection fails without spawning).
 * - Reporter iteration aggregation (duration sum, fail-if-any).
 *
 * Run: npx tsx --test tests/integration/datasets.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import {
  ensureIntegrationDb,
  injectJson,
  loginFixtureDefinition,
} from './helpers.js';
import { runTest } from '../../apps/runner/src/run.js';
import { InMemoryRunStore } from '../../apps/runner/src/persist.js';
import { compileSpec } from '../../apps/runner/src/compile.js';
import {
  buildDatasetEnvValue,
  resolveDatasetRows,
  ValidationError,
} from '../../apps/runner/src/datasets.js';
import type { RunEvent } from '../../apps/runner/src/events.js';
import type { RunRequest } from '../../apps/runner/src/types.js';
import { mergeIterationEntry, P0Reporter } from '../../packages/reporter/src/reporter.js';

process.env.SKIP_LISTEN = '1';
const { buildApp } = await import('../../apps/server/src/app.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURE_STUB = join(HERE, 'stub-capture-rows.mjs');

let app: FastifyInstance;
let storageRoot: string;
let prevStorageRoot: string | undefined;
let prevBroadcast: unknown;
const wsEvents: Array<{ event: string; payload: unknown }> = [];

before(async () => {
  await ensureIntegrationDb();
  app = await buildApp();
  prevBroadcast = (globalThis as Record<string, unknown>).__vvWsBroadcast;
  (globalThis as Record<string, unknown>).__vvWsBroadcast = (event: string, payload: unknown) => {
    wsEvents.push({ event, payload });
  };
  storageRoot = mkdtempSync(join(tmpdir(), 'vv-ds-storage-'));
  prevStorageRoot = process.env.STORAGE_ROOT;
  process.env.STORAGE_ROOT = storageRoot;
});

after(async () => {
  (globalThis as Record<string, unknown>).__vvWsBroadcast = prevBroadcast;
  process.env.STORAGE_ROOT = prevStorageRoot;
  await app.close();
});

const CSV_QUIRKY = 'EMAIL,CITY,NOTE\r\n"a@x.com","Hanoi","loves, commas"\r\nb@x.com,Saigon,"line1\nline2"\r\nc@x.com,Hue,"says ""hi"""\r\n';

async function makeDefinitionTest(name: string, stepsExtra?: unknown): Promise<{ projectId: string; testId: string }> {
  const projectId = ((await injectJson(app, 'POST', '/api/v1/projects', { name })).json() as { id: string }).id;
  const def = loginFixtureDefinition(projectId, 'http://127.0.0.1:3123');
  const testId = ((await injectJson(app, 'POST', `/api/v1/projects/${projectId}/tests`, {
    name, definitionJson: { ...def, ...(stepsExtra ? { steps: stepsExtra } : {}) },
  })).json() as { id: string }).id;
  return { projectId, testId };
}

async function makeEnv(projectId: string): Promise<string> {
  return ((await injectJson(app, 'POST', `/api/v1/projects/${projectId}/environments`, { name: 'ds-env' })).json() as { id: string }).id;
}

describe('dataset import (CSV/JSON → embedded definition.datasets)', () => {
  it('imports quirky CSV (quotes/commas/newlines) into rows', async () => {
    const { testId } = await makeDefinitionTest('ds-csv-proj');
    const res = await injectJson(app, 'POST', `/api/v1/tests/${testId}/datasets/import`, {
      format: 'csv', name: 'users', content: CSV_QUIRKY,
    });
    assert.equal(res.statusCode, 201);
    const body = res.json() as { dataset: { id: string; name: string; rows: Record<string, string>[] } };
    assert.equal(body.dataset.name, 'users');
    assert.ok(body.dataset.id.startsWith('ds_'));
    assert.deepEqual(body.dataset.rows, [
      { EMAIL: 'a@x.com', CITY: 'Hanoi', NOTE: 'loves, commas' },
      { EMAIL: 'b@x.com', CITY: 'Saigon', NOTE: 'line1\nline2' },
      { EMAIL: 'c@x.com', CITY: 'Hue', NOTE: 'says "hi"' },
    ]);
    // Persisted into the stored definition.
    const testRow = (await injectJson(app, 'GET', `/api/v1/tests/${testId}`)).json() as { definitionJson: string };
    const stored = JSON.parse(testRow.definitionJson) as { datasets: unknown[] };
    assert.equal(stored.datasets.length, 1);
  });

  it('imports JSON arrays with scalar coercion', async () => {
    const { testId } = await makeDefinitionTest('ds-json-proj');
    const res = await injectJson(app, 'POST', `/api/v1/tests/${testId}/datasets/import`, {
      format: 'json', name: 'nums', content: '[{"A":"x","N":3,"B":true,"Z":null}]',
    });
    assert.equal(res.statusCode, 201);
    const body = res.json() as { dataset: { rows: Record<string, string>[] } };
    assert.deepEqual(body.dataset.rows, [{ A: 'x', N: '3', B: 'true', Z: '' }]);
  });

  it('rejects bad payloads explicitly (never silently stored)', async () => {
    const { testId } = await makeDefinitionTest('ds-bad-proj');
    const cases: Array<[unknown, number]> = [
      [{ format: 'csv', content: 'A,B\n1,2\n' }, 201], // default name ok
      [{ format: 'csv', name: 'dup', content: 'A,B\n1,2\n' }, 201],
      [{ format: 'csv', name: 'dup', content: 'A,B\n3,4\n' }, 201], // same columns → append
      [{ format: 'csv', name: 'dup', content: 'A,C\n5,6\n' }, 400], // column mismatch
      [{ format: 'csv', content: 'A,Has Space\n1,2\n' }, 400], // bad column
      [{ format: 'csv', content: 'A,A\n1,2\n' }, 400], // duplicates
      [{ format: 'csv', content: 'A,B\n' }, 400], // header only
      [{ format: 'json', content: '{"a":1}' }, 400], // not an array
      [{ format: 'json', content: '[{"A":{"x":1}}]' }, 400], // nested
      [{ format: 'yaml', content: 'a: 1' }, 400], // bad enum
    ];
    for (const [payload, expected] of cases) {
      const res = await injectJson(app, 'POST', `/api/v1/tests/${testId}/datasets/import`, payload);
      assert.equal(res.statusCode, expected, `payload ${JSON.stringify(payload)}`);
    }
    // The two successful 'dup' imports appended into ONE dataset.
    const testRow = (await injectJson(app, 'GET', `/api/v1/tests/${testId}`)).json() as { definitionJson: string };
    const stored = JSON.parse(testRow.definitionJson) as { datasets: { name: string; rows: unknown[] }[] };
    assert.equal(stored.datasets.find((d) => d.name === 'dup')?.rows.length, 2);
  });

  it('enforces the 500-row cap', async () => {
    const { testId } = await makeDefinitionTest('ds-cap-proj');
    const big = `A\n${Array.from({ length: 501 }, (_, i) => `r${i}`).join('\n')}\n`;
    const res = await injectJson(app, 'POST', `/api/v1/tests/${testId}/datasets/import`, {
      format: 'csv', name: 'big', content: big,
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().code as string, /VALIDATION_ERROR/);
  });

  it('DELETE removes one embedded dataset (404 for unknown)', async () => {
    const { testId } = await makeDefinitionTest('ds-del-proj');
    const imported = (await injectJson(app, 'POST', `/api/v1/tests/${testId}/datasets/import`, {
      format: 'csv', name: 'gone', content: 'A\n1\n',
    })).json() as { dataset: { id: string } };
    const del = await injectJson(app, 'DELETE', `/api/v1/tests/${testId}/datasets/${imported.dataset.id}`);
    assert.equal(del.statusCode, 200);
    const again = await injectJson(app, 'DELETE', `/api/v1/tests/${testId}/datasets/${imported.dataset.id}`);
    assert.equal(again.statusCode, 404);
  });
});

describe('run creation with datasets (validation + persistence)', () => {
  it('rejects unknown datasetId / bad rowIndex / rowIndex-without-dataset', async () => {
    const { projectId, testId } = await makeDefinitionTest('ds-runval-proj');
    const envId = await makeEnv(projectId);
    const ds = (await injectJson(app, 'POST', `/api/v1/tests/${testId}/datasets/import`, {
      format: 'csv', name: 'u', content: 'A\n1\n2\n',
    })).json() as { dataset: { id: string } };
    const badId = await injectJson(app, 'POST', `/api/v1/tests/${testId}/runs`, { environmentId: envId, datasetId: 'ds_nope' });
    assert.equal(badId.statusCode, 400);
    const badRow = await injectJson(app, 'POST', `/api/v1/tests/${testId}/runs`, { environmentId: envId, datasetId: ds.dataset.id, rowIndex: 7 });
    assert.equal(badRow.statusCode, 400);
    const negRow = await injectJson(app, 'POST', `/api/v1/tests/${testId}/runs`, { environmentId: envId, datasetId: ds.dataset.id, rowIndex: -1 });
    assert.equal(negRow.statusCode, 400);
    const loneRow = await injectJson(app, 'POST', `/api/v1/tests/${testId}/runs`, { environmentId: envId, rowIndex: 0 });
    assert.equal(loneRow.statusCode, 400);
  });

  it('persists datasetId/rowIndex on the Run row', async () => {
    const { projectId, testId } = await makeDefinitionTest('ds-runpersist-proj', [
      { id: 's1', type: 'reload', enabled: true },
    ]);
    const envId = await makeEnv(projectId);
    const ds = (await injectJson(app, 'POST', `/api/v1/tests/${testId}/datasets/import`, {
      format: 'csv', name: 'u', content: 'A\n1\n2\n',
    })).json() as { dataset: { id: string } };
    const created = await injectJson(app, 'POST', `/api/v1/tests/${testId}/runs`, {
      environmentId: envId, datasetId: ds.dataset.id, rowIndex: 1,
    });
    assert.equal(created.statusCode, 202);
    const runId = (created.json() as { id: string }).id;
    // Cancel immediately: the worker skips queued-cancelled runs, so no
    // browser spawns; the persisted selection stays observable either way.
    await injectJson(app, 'POST', `/api/v1/runs/${runId}/cancel`);
    const detail = (await injectJson(app, 'GET', `/api/v1/runs/${runId}`)).json() as {
      datasetId: string | null; rowIndex: number | null;
    };
    assert.equal(detail.datasetId, ds.dataset.id);
    assert.equal(detail.rowIndex, 1);
  });
});

describe('compile/export preview with datasetId', () => {
  it('emits the loop for a selected dataset, P0 output otherwise', async () => {
    const { testId } = await makeDefinitionTest('ds-compile-proj');
    await injectJson(app, 'POST', `/api/v1/tests/${testId}/datasets/import`, {
      format: 'csv', name: 'u', content: 'EMAIL\na@x.com\n',
    });
    const testRow = (await injectJson(app, 'GET', `/api/v1/tests/${testId}`)).json() as { definitionJson: string };
    const dsId = (JSON.parse(testRow.definitionJson) as { datasets: { id: string }[] }).datasets[0].id;

    const looped = await injectJson(app, 'POST', `/api/v1/tests/${testId}/compile`, { datasetId: dsId });
    assert.equal(looped.statusCode, 200);
    const code = (looped.json() as { code: string }).code;
    assert.match(code, /VV_DATASET_ROWS/);
    assert.match(code, /_vvIteration/);

    const plain = await injectJson(app, 'POST', `/api/v1/tests/${testId}/compile`, {});
    assert.equal(plain.statusCode, 200);
    assert.ok(!(plain.json() as { code: string }).code.includes('_vvIteration'));

    const unknown = await injectJson(app, 'POST', `/api/v1/tests/${testId}/compile`, { datasetId: 'ds_nope' });
    assert.equal(unknown.statusCode, 422);

    const exported = await app.inject({
      method: 'GET',
      url: `/api/v1/tests/${testId}/export?format=spec&datasetId=${dsId}`,
      headers: { 'x-user-id': 'u_integration' },
    });
    assert.equal(exported.statusCode, 200);
    assert.match(exported.body, /VV_DATASET_ROWS/);
  });
});

describe('runner dataset resolution (unit)', () => {
  const test = {
    schemaVersion: '1.0',
    id: 't',
    projectId: 'p',
    name: 't',
    browser: 'chromium',
    datasets: [{ id: 'ds1', name: 'D', rows: [{ A: '1' }, { A: '2' }] }],
    steps: [{ id: 's1', type: 'reload', enabled: true }],
  } as unknown as RunRequest['test'];

  it('returns [] without datasetId; filters rowIndex; rejects bad selections', () => {
    assert.deepEqual(resolveDatasetRows(test), []);
    assert.deepEqual(resolveDatasetRows(test, 'ds1'), [{ A: '1' }, { A: '2' }]);
    assert.deepEqual(resolveDatasetRows(test, 'ds1', 1), [{ A: '2' }]);
    assert.throws(() => resolveDatasetRows(test, 'ds_nope'), ValidationError);
    assert.throws(() => resolveDatasetRows(test, 'ds1', 5), ValidationError);
    assert.throws(() => resolveDatasetRows(test, undefined, 0), ValidationError);
  });

  it('buildDatasetEnvValue caps oversized payloads (no silent truncation)', () => {
    assert.ok(buildDatasetEnvValue([{ A: '1' }]).includes('"A"'));
    const huge = [{ A: 'x'.repeat(300 * 1024) }];
    assert.throws(() => buildDatasetEnvValue(huge), ValidationError);
  });

  it('runner compileSpec emits the loop only with datasetId (P0 identical otherwise)', () => {
    const looped = compileSpec(test, { datasetId: 'ds1' });
    assert.match(looped, /VV_DATASET_ROWS/);
    assert.match(looped, /\(row\["A"\] \?\? ''\)|_vvIteration/);
    const plain = compileSpec({ ...test, steps: [{ id: 's1', type: 'reload', enabled: true }] });
    assert.ok(!plain.includes('_vvIteration'));
    assert.throws(() => compileSpec(test, { datasetId: 'ds_nope' }), /Unknown datasetId/);
  });
});

describe('runTest with dataset (stubbed Playwright, no browser)', () => {
  function baseRequest(runId: string, extra: Partial<RunRequest> = {}): RunRequest {
    const def = loginFixtureDefinition('p_fixture', 'http://127.0.0.1:3123') as unknown as RunRequest['test'];
    return {
      runId,
      test: {
        ...def,
        datasets: [{ id: 'ds1', name: 'Users', rows: [{ EMAIL: 'a@x.com' }, { EMAIL: 'b@x.com' }] }],
      },
      projectId: 'p_fixture',
      browser: 'chromium',
      trigger: 'integration-test',
      ...extra,
    };
  }

  it('passes with a dataset; VV_DATASET_ROWS carries all rows', async () => {
    const store = new InMemoryRunStore();
    const events: RunEvent[] = [];
    const capture = join(storageRoot, 'vv-rows-all.json');
    process.env.VV_CAPTURE_PATH = capture;
    try {
      const runId = 'run-ds-all-1';
      const { status } = await runTest(baseRequest(runId, { datasetId: 'ds1' }), {
        store,
        publish: (e: RunEvent) => { events.push(e); },
        reporterPath: join(storageRoot, 'reporter.js'),
        playwrightCommand: { command: process.execPath, baseArgs: [CAPTURE_STUB] },
      });
      assert.equal(status, 'passed');
      assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), [{ EMAIL: 'a@x.com' }, { EMAIL: 'b@x.com' }]);
      const summary = (await store.getSummary(runId))!;
      assert.equal(summary.run.status, 'passed');
    } finally {
      delete process.env.VV_CAPTURE_PATH;
    }
  });

  it('rowIndex injects exactly one row', async () => {
    const store = new InMemoryRunStore();
    const capture = join(storageRoot, 'vv-rows-one.json');
    process.env.VV_CAPTURE_PATH = capture;
    try {
      const runId = 'run-ds-row-1';
      const { status } = await runTest(baseRequest(runId, { datasetId: 'ds1', rowIndex: 1 }), {
        store,
        publish: () => {},
        reporterPath: join(storageRoot, 'reporter.js'),
        playwrightCommand: { command: process.execPath, baseArgs: [CAPTURE_STUB] },
      });
      assert.equal(status, 'passed');
      assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), [{ EMAIL: 'b@x.com' }]);
    } finally {
      delete process.env.VV_CAPTURE_PATH;
    }
  });

  it('unknown datasetId fails fast without spawning Playwright', async () => {
    const store = new InMemoryRunStore();
    const events: RunEvent[] = [];
    const marker = join(storageRoot, 'ds-never-spawn.marker');
    const { status } = await runTest(baseRequest('run-ds-bad-1', { datasetId: 'ds_nope' }), {
      store,
      publish: (e: RunEvent) => { events.push(e); },
      reporterPath: 'unused',
      playwrightCommand: {
        command: process.execPath,
        baseArgs: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`],
      },
    });
    assert.equal(status, 'failed');
    assert.ok(!fileExists(marker), 'Playwright must not spawn for an unknown dataset');
    assert.deepEqual(events.map((e) => e.event), ['run.queued', 'run.failed']);
  });
});

describe('reporter iteration aggregation', () => {
  it('mergeIterationEntry: durations sum, any failure fails, first error kept', () => {
    const merged = mergeIterationEntry(
      { stepId: 's1', status: 'passed', startedAt: 100, finishedAt: 130, durationMs: 30 },
      { stepId: 's1', status: 'failed', startedAt: 200, finishedAt: 250, durationMs: 50, error: 'row 2 boom' },
    );
    assert.equal(merged.stepId, 's1');
    assert.equal(merged.status, 'failed');
    assert.equal(merged.durationMs, 80);
    assert.equal(merged.startedAt, 100);
    assert.equal(merged.finishedAt, 250);
    assert.equal(merged.error, 'row 2 boom');
    const allPassed = mergeIterationEntry(
      { stepId: 's1', status: 'passed', startedAt: 100, finishedAt: 110, durationMs: 10 },
      { stepId: 's1', status: 'passed', startedAt: 200, finishedAt: 220, durationMs: 20 },
    );
    assert.equal(allPassed.status, 'passed');
    assert.equal(allPassed.durationMs, 30);
    assert.equal(allPassed.error, undefined);
  });

  it('same step twice through P0Reporter merges into one failed record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vv-rep-'));
    const reporter = new P0Reporter({
      runId: 'r_ds',
      artifactDir: dir,
      stepsMeta: [{ stepId: 's1', name: 'Fill', enabled: true }],
    });
    const stepBegin = { title: '[s1] Fill #1', category: 'test.step', duration: 0 } as never;
    reporter.onStepBegin?.({}, {}, stepBegin);
    await new Promise((r) => setTimeout(r, 5));
    reporter.onStepEnd?.({}, {}, { ...stepBegin, duration: 10 } as never);
    const stepBegin2 = { title: '[s1] Fill #2', category: 'test.step', duration: 0 } as never;
    reporter.onStepBegin?.({}, {}, stepBegin2);
    await new Promise((r) => setTimeout(r, 5));
    reporter.onStepEnd?.({}, {}, { ...stepBegin2, duration: 20, error: new Error('row 2 boom') } as never);
    await reporter.onEnd?.({ status: 'failed' } as never);
    const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as {
      status: string; steps: { stepId: string; status: string; durationMs: number; error?: string }[];
    };
    assert.equal(result.status, 'failed');
    assert.equal(result.steps.filter((s) => s.stepId === 's1').length, 1, 'one record per step id');
    const s1 = result.steps.find((s) => s.stepId === 's1')!;
    assert.equal(s1.status, 'failed', 'any failed iteration fails the step');
    assert.ok(s1.durationMs >= 10, `durations summed across iterations (got ${s1.durationMs})`);
    assert.match(s1.error ?? '', /row 2 boom/);
  });
});

function fileExists(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}
