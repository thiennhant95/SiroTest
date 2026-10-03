/**
 * Integration: P2 visual regression run wiring (stubbed browser).
 *
 * Exercises the full runner path with REAL PNG bytes and the REAL
 * isolated-workdir helper: compileSpec emit -> vv-visual-compare.cjs
 * materialization -> VV_BASELINES/VV_UPDATE_BASELINES/VV_VISUAL_STEPS env
 * injection -> stub executes compareVisualFromEnv -> artifacts/events/status.
 * Only screenshot capture itself is synthetic (no browser required).
 *
 * Also covers plugin gating at run level: disabled/missing plugins fail
 * explicitly before any spawn (PLUGIN_DISABLED / PLUGIN_NOT_FOUND).
 *
 * Run: npx tsx --test tests/integration/visual-run.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTest } from '../../apps/runner/src/run.js';
import { InMemoryRunStore } from '../../apps/runner/src/persist.js';
import { encodePngImage } from '../../apps/runner/src/visual-compare.js';
import type { RunRequest } from '../../apps/runner/src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, 'stub-playwright-visual.mjs');

let storageRoot;
let prevStorageRoot;
let prevAllow;
let prevPluginsDir;

function solidPng(w, h, r, g, b) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
  }
  return encodePngImage(w, h, rgba);
}

before(() => {
  storageRoot = mkdtempSync(join(tmpdir(), 'vv-visual-int-storage-'));
  prevStorageRoot = process.env.STORAGE_ROOT;
  process.env.STORAGE_ROOT = storageRoot;
  prevAllow = process.env.ALLOW_PLUGINS;
  prevPluginsDir = process.env.PLUGINS_DIR;
  delete process.env.ALLOW_PLUGINS;
  delete process.env.PLUGINS_DIR;
});

after(() => {
  process.env.STORAGE_ROOT = prevStorageRoot;
  if (prevAllow === undefined) delete process.env.ALLOW_PLUGINS;
  else process.env.ALLOW_PLUGINS = prevAllow;
  if (prevPluginsDir === undefined) delete process.env.PLUGINS_DIR;
  else process.env.PLUGINS_DIR = prevPluginsDir;
});

function visualDef() {
  return {
    schemaVersion: '1.0',
    id: 'test_visual',
    projectId: 'p_visual',
    name: 'Visual test',
    browser: 'chromium',
    steps: [{ id: 'v1', type: 'visualCheck', enabled: true, name: 'hero' }],
  };
}

function stubDeps(store, events, extraArgs = []) {
  return {
    store,
    publish: (e) => { events.push(e); },
    reporterPath: join(storageRoot, 'reporter.js'),
    playwrightCommand: { command: process.execPath, baseArgs: [STUB, ...extraArgs] },
  };
}

describe('visual run: baseline match passes', () => {
  it('passed + actual artifact collected + step.passed event', async () => {
    const store = new InMemoryRunStore();
    const events = [];
    const runId = 'run-visual-pass-1';
    const baselineAbs = join(storageRoot, 'baseline-hero.png');
    writeFileSync(baselineAbs, solidPng(8, 8, 10, 20, 30));
    const req = {
      runId,
      test: visualDef(),
      projectId: 'p_visual',
      browser: 'chromium',
      baselines: { hero: baselineAbs },
    };
    const { status } = await runTest(req, stubDeps(store, events));
    assert.equal(status, 'passed');
    const summary = (await store.getSummary(runId));
    assert.equal(summary.run.status, 'passed');
    assert.equal(summary.steps[0].status, 'passed');
    const names = events.map((e) => e.event);
    assert.ok(names.includes('step.passed'));
    assert.equal(names[names.length - 1], 'run.passed');
    const paths = summary.artifacts.map((a) => a.path);
    assert.ok(paths.includes(`runs/${runId}/screenshots/visual-hero.png`), `actual collected (${paths})`);
    assert.ok(existsSync(join(storageRoot, 'runs', runId, 'screenshots', 'visual-hero.png')));
  });
});

describe('visual run: diff over threshold fails with metrics + diff artifact', () => {
  it('failed + VISUAL_DIFF_EXCEEDED + visual-hero.diff.png collected', async () => {
    const store = new InMemoryRunStore();
    const events = [];
    const runId = 'run-visual-diff-1';
    const baselineAbs = join(storageRoot, 'baseline-hero2.png');
    writeFileSync(baselineAbs, solidPng(8, 8, 0, 0, 0));
    const req = {
      runId,
      test: visualDef(),
      projectId: 'p_visual',
      browser: 'chromium',
      baselines: { hero: baselineAbs },
    };
    const { status } = await runTest(req, stubDeps(store, events, ['--visual-diff']));
    assert.equal(status, 'failed');
    const summary = (await store.getSummary(runId));
    assert.equal(summary.run.status, 'failed');
    assert.equal(summary.steps[0].status, 'failed');
    assert.match(summary.steps[0].errorMessage, /VISUAL_DIFF_EXCEEDED/);
    assert.match(summary.steps[0].errorMessage, /64\/64 pixels differ/);
    const paths = summary.artifacts.map((a) => a.path);
    assert.ok(paths.includes(`runs/${runId}/screenshots/visual-hero.diff.png`), `diff collected (${paths})`);
    assert.ok(existsSync(join(storageRoot, 'runs', runId, 'screenshots', 'visual-hero.diff.png')));
    const resultJson = JSON.parse(readFileSync(join(storageRoot, 'runs', runId, 'result.json'), 'utf8'));
    assert.equal(resultJson.status, 'failed');
  });
});

describe('visual run: capture and missing-baseline modes', () => {
  it('updateBaselines passes without baselines (capture for server promote)', async () => {
    const store = new InMemoryRunStore();
    const events = [];
    const runId = 'run-visual-capture-1';
    const req = {
      runId, test: visualDef(), projectId: 'p_visual', browser: 'chromium', updateBaselines: true,
    };
    const { status } = await runTest(req, stubDeps(store, events));
    assert.equal(status, 'passed');
    const summary = (await store.getSummary(runId));
    assert.ok(summary.artifacts.some((a) => a.path.endsWith('visual-hero.png')), 'actual kept for promote');
  });

  it('missing baseline without update mode fails explicitly (never silently adopts)', async () => {
    const store = new InMemoryRunStore();
    const events = [];
    const runId = 'run-visual-missing-1';
    const req = { runId, test: visualDef(), projectId: 'p_visual', browser: 'chromium' };
    const { status } = await runTest(req, stubDeps(store, events));
    assert.equal(status, 'failed');
    const summary = (await store.getSummary(runId));
    assert.match(summary.steps[0].errorMessage, /VISUAL_BASELINE_MISSING/);
  });
});

describe('plugin run gating (no silent skips)', () => {
  function pluginDef() {
    return {
      schemaVersion: '1.0',
      id: 'test_plugin',
      projectId: 'p_plugin',
      name: 'Plugin test',
      browser: 'chromium',
      steps: [{ id: 'p1', type: 'plugin:kv.fillMasked', enabled: true, params: { label: 'E', value: '{{PW}}' } }],
    };
  }

  it('plugins disabled -> run fails fast with PLUGIN_DISABLED (never spawns)', async () => {
    const store = new InMemoryRunStore();
    const events = [];
    const marker = join(storageRoot, 'should-never-spawn-plugin.marker');
    const { status } = await runTest(
      { runId: 'run-plugin-disabled-1', test: pluginDef(), projectId: 'p_plugin', browser: 'chromium' },
      {
        store,
        publish: (e) => { events.push(e); },
        reporterPath: 'unused',
        playwrightCommand: {
          command: process.execPath,
          baseArgs: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`],
        },
      },
    );
    assert.equal(status, 'failed');
    assert.ok(!existsSync(marker), 'worker must not spawn when plugins are disabled');
    const summary = (await store.getSummary('run-plugin-disabled-1'));
    assert.match(summary.run.errorSummary ?? summary.steps[0]?.errorMessage ?? '', /PLUGIN_DISABLED/);
  });

  it('enabled but unregistered type -> PLUGIN_NOT_FOUND', async () => {
    process.env.ALLOW_PLUGINS = '1';
    process.env.PLUGINS_DIR = mkdtempSync(join(tmpdir(), 'vv-visual-empty-plugins-'));
    try {
      const store = new InMemoryRunStore();
      const events = [];
      const { status } = await runTest(
        { runId: 'run-plugin-missing-1', test: pluginDef(), projectId: 'p_plugin', browser: 'chromium' },
        stubDeps(store, events),
      );
      assert.equal(status, 'failed');
      const summary = (await store.getSummary('run-plugin-missing-1'));
      const text = `${summary.run.errorSummary ?? ''} ${summary.steps.map((s) => s.errorMessage ?? '').join(' ')}`;
      assert.match(text, /PLUGIN_NOT_FOUND/);
    } finally {
      delete process.env.ALLOW_PLUGINS;
      delete process.env.PLUGINS_DIR;
    }
  });
});
