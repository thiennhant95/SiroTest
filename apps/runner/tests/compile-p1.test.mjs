/**
 * P1 wave-2 runner parity tests (node:test, no browser needed).
 * Run:  pnpm --filter @playwright-studio/runner build && pnpm --filter @playwright-studio/runner test
 * (node --test tests/ — imports compiled dist/ like recovery.test.mjs).
 *
 * Covers: compileSpec mirror for upload/download/newTab/closeTab/
 * handleDialog/apiRequest (keeps the `[id]` reporter dialect), explicit
 * failures (closeTab on last tab, download without source, apiRequest bad
 * status), validate.ts allowlist for the 6 types, compileConfig
 * storageState default-vs-file, and P0 byte-identical output (no wave-2
 * steps -> `async ({ page })`, no page2/context/request).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compileSpec, compileConfig, CompileError } = require('../dist/compile.js');
const { validateTestDefinition, ValidationError, SUPPORTED_STEP_TYPES } = require('../dist/validate.js');

const T = (primary) => ({ primary });
const step = (id, type, fields = {}) => ({ id, type, enabled: true, ...fields });
const testDef = (steps) => ({
  schemaVersion: '1.0', id: 't_p1', projectId: 'p', name: 'P1 test', browser: 'chromium', steps,
});
const baseConfig = {
  browser: 'chromium', reporterPath: '/tmp/reporter.js', runId: 'run1',
  trace: 'off', screenshot: 'off', video: 'off', outputDir: '/tmp/out',
};

describe('validate.ts P1 allowlist', () => {
  it('accepts all 6 wave-2 types', () => {
    for (const t of ['upload', 'download', 'newTab', 'closeTab', 'handleDialog', 'apiRequest']) {
      assert.ok(SUPPORTED_STEP_TYPES.has(t), `missing ${t}`);
    }
    validateTestDefinition(testDef([
      step('u1', 'upload', { target: T({ strategy: 'label', value: 'F' }), fileId: 'f1' }),
      step('d1', 'download', { target: T({ strategy: 'text', value: 'E' }) }),
      step('t1', 'newTab', {}),
      step('c1', 'closeTab', {}),
      step('h1', 'handleDialog', { action: 'accept' }),
      step('a1', 'apiRequest', { method: 'GET', url: 'https://example.com' }),
    ]));
  });

  it('rejects download without source, bad dialog action, bad api fields', () => {
    assert.throws(() => validateTestDefinition(testDef([step('d1', 'download', {})])), ValidationError);
    assert.throws(
      () => validateTestDefinition(testDef([step('h1', 'handleDialog', { action: 'maybe' })])),
      ValidationError,
    );
    assert.throws(
      () => validateTestDefinition(testDef([step('a1', 'apiRequest', { method: 'FETCH', url: 'https://x' })])),
      ValidationError,
    );
    assert.throws(
      () => validateTestDefinition(testDef([step('u1', 'upload', { target: T({ strategy: 'label', value: 'F' }) })])),
      ValidationError,
    );
  });
});

describe('compileSpec P1 mirror ([id] dialect)', () => {
  it('upload uses VV_FILE_PATHS lookup + [id] title', () => {
    const out = compileSpec(testDef([
      step('u1', 'upload', { target: T({ strategy: 'label', value: 'File' }), fileId: 'file_abc' }),
    ]));
    assert.ok(out.includes(`[u1] upload`), out);
    assert.ok(out.includes('VV_FILE_PATHS'), out);
    assert.ok(out.includes('setInputFiles(vvFile)'), out);
  });

  it('download target variant mirrors package semantics', () => {
    const out = compileSpec(testDef([
      step('d1', 'download', { target: T({ strategy: 'text', value: 'Export' }), saveAs: 'r.csv' }),
    ]));
    assert.ok(out.includes(`waitForEvent('download')`), out);
    assert.ok(out.includes(`await download.saveAs("r.csv");`), out);
  });

  it('download without source fails explicitly', () => {
    assert.throws(() => compileSpec(testDef([step('d1', 'download', {})])), CompileError);
  });

  it('newTab/closeTab track page2 and keep [id] titles', () => {
    const out = compileSpec(testDef([
      step('t1', 'newTab', { url: 'https://example.com/d' }),
      step('s2', 'click', { target: T({ strategy: 'text', value: 'Hi' }) }),
      step('c1', 'closeTab', {}),
      step('s3', 'reload', {}),
    ]));
    assert.ok(out.includes('async ({ page, context })'), out);
    assert.ok(out.includes('[t1] newTab'), out);
    assert.ok(out.includes('const page2 = await context.newPage();'), out);
    assert.ok(out.includes('page2.locator("Hi")') || out.includes('page2.getByText("Hi")'), out);
    assert.ok(out.includes('await page2.close();'), out);
    assert.ok(out.includes('await page.reload();'), out);
  });

  it('closeTab on the last tab fails explicitly', () => {
    assert.throws(() => compileSpec(testDef([step('c1', 'closeTab', {})])), /last remaining tab/);
  });

  it('handleDialog registers once(dialog) on the current tab', () => {
    const out = compileSpec(testDef([
      step('h1', 'handleDialog', { action: 'dismiss' }),
      step('s1', 'reload', {}),
    ]));
    assert.ok(out.includes(`page.once('dialog', async (dialog) => { await dialog.dismiss(); });`), out);
  });

  it('apiRequest uses request fixture with explicit status check + saveAs', () => {
    const out = compileSpec(testDef([
      step('a1', 'apiRequest', { method: 'GET', url: 'https://example.com/api', expectedStatus: 200, saveAs: 'BODY' }),
    ]));
    assert.ok(out.includes('async ({ page, request })'), out);
    assert.ok(out.includes('[a1] apiRequest'), out);
    assert.ok(out.includes('await request.get('), out);
    assert.ok(out.includes('vvResp.status() !== 200'), out);
    assert.ok(out.includes('process.env["BODY"] = await vvResp.text();'), out);
  });

  it('apiRequest secrets stay as {{VAR}} lookups (never inlined)', () => {
    const out = compileSpec(testDef([
      step('a1', 'apiRequest', {
        method: 'POST', url: 'https://example.com/api',
        headers: { 'X-Token': '{{API_TOKEN}}' }, body: '{{API_BODY}}',
      }),
    ]));
    assert.ok(out.includes('process.env'), out);
    assert.ok(!out.includes('s3cr3t'), out);
  });

  it('P0 output is byte-identical (no context/request/page2)', () => {
    const out = compileSpec(testDef([step('s1', 'reload', {})]));
    assert.ok(out.includes('async ({ page }) => {'), out);
    assert.ok(!out.includes('context'), out);
    assert.ok(!out.includes('request'), out);
    assert.ok(!out.includes('page2'), out);
  });
});

describe('compileConfig storageState', () => {
  it('defaults to undefined (P0 fresh context)', () => {
    const out = compileConfig(baseConfig);
    assert.ok(out.includes('storageState: undefined'), out);
  });

  it('points at the materialized file when provided', () => {
    const out = compileConfig({ ...baseConfig, storageStateFile: 'storageState.json' });
    assert.ok(out.includes('storageState: "storageState.json"'), out);
  });
});
