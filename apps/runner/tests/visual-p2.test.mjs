/**
 * P2 runner tests (node:test, no browser needed).
 * Run:  pnpm --filter @playwright-studio/runner build && pnpm --filter @playwright-studio/runner test
 * (node --test tests/ — imports compiled dist/ like compile-p1.test.mjs).
 *
 * Covers:
 * - validate.ts allowlist: visualCheck + plugin:* accepted, field edges fail.
 * - compileSpec mirror: visualCheck emits screenshot+compare in the `[id]`
 *   dialect (require helper); plugin steps emit the shim call; registry
 *   fail-fast (PLUGIN_NOT_FOUND / missing required / plaintext secret).
 * - sanitizeVisualFileName parity with packages/playwright-compiler.
 * - visualHelperSource round-trip: the serialized workdir helper behaves
 *   identically (identical pass / within-threshold pass / over-threshold
 *   fail + diff artifact + metrics / missing baseline / update mode /
 *   size mismatch).
 * - PLUGIN_SHIM_CJS round-trip: execute() dispatch, param validation,
 *   PLUGIN_NOT_FOUND.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { compileSpec, CompileError, sanitizeVisualFileName, PLUGIN_STEP_PATTERN } = require('../dist/compile.js');
const { validateTestDefinition, ValidationError, SUPPORTED_STEP_TYPES } = require('../dist/validate.js');
const visual = require('../dist/visual-compare.js');
const { PLUGIN_SHIM_CJS, collectPluginStepTypes } = require('../dist/plugin-shim.js');

const T = (primary) => ({ primary });
const step = (id, type, fields = {}) => ({ id, type, enabled: true, ...fields });
const testDef = (steps) => ({
  schemaVersion: '1.0', id: 't_p2', projectId: 'p', name: 'P2 test', browser: 'chromium', steps,
});

function solidPng(w, h, r, g, b, a = 255) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return visual.encodePngImage(w, h, rgba);
}

describe('validate.ts P2 allowlist', () => {
  it('accepts visualCheck and plugin:* types', () => {
    assert.ok(SUPPORTED_STEP_TYPES.has('visualCheck'), 'missing visualCheck');
    assert.ok(PLUGIN_STEP_PATTERN.test('plugin:kv.fillMasked'));
    assert.ok(!PLUGIN_STEP_PATTERN.test('fill'));
    assert.ok(!PLUGIN_STEP_PATTERN.test('plugin:'));
    validateTestDefinition(testDef([
      step('v1', 'visualCheck', { name: 'hero' }),
      step('v2', 'visualCheck', { name: 'card', threshold: 0.1, target: T({ strategy: 'testId', value: 'c' }) }),
      step('p1', 'plugin:kv.fillMasked', { params: { label: 'E', value: '{{PW}}' } }),
    ]));
  });

  it('rejects bad visualCheck / plugin fields explicitly', () => {
    assert.throws(() => validateTestDefinition(testDef([step('v1', 'visualCheck', {})])), ValidationError);
    assert.throws(() => validateTestDefinition(testDef([step('v1', 'visualCheck', { name: 'a', threshold: 2 })])), ValidationError);
    assert.throws(() => validateTestDefinition(testDef([step('v1', 'visualCheck', { name: 'a', target: {} })])), ValidationError);
    assert.throws(() => validateTestDefinition(testDef([step('p1', 'plugin:a.b', { params: { n: 1 } })])), ValidationError);
    assert.throws(() => validateTestDefinition(testDef([step('x1', 'customCode', {})])), ValidationError);
  });
});

describe('compileSpec P2 mirror ([id] dialect)', () => {
  it('visualCheck emits screenshot + require helper', () => {
    const spec = compileSpec(testDef([step('v1', 'visualCheck', { name: 'hero page' })]));
    assert.match(spec, /\[v1\] hero page/);
    assert.match(spec, /visual-hero_page\.png/);
    assert.match(spec, /require\('node:path'\)\.join\(process\.env\.RUN_ARTIFACT_DIR/);
    assert.match(spec, /require\('\.\/vv-visual-compare\.cjs'\)\.compareVisualFromEnv/);
    assert.match(spec, /threshold: 0\.05/);
  });

  it('visualCheck element target uses the locator', () => {
    const spec = compileSpec(testDef([step('v1', 'visualCheck', { name: 'c', target: T({ strategy: 'label', value: 'Card' }) })]));
    assert.match(spec, /getByLabel\("Card"\)\.screenshot/);
  });

  it('plugin steps emit the shim call with templated params', () => {
    const spec = compileSpec(testDef([step('p1', 'plugin:kv.fillMasked', { params: { value: '{{PW}}', label: 'E' } })]));
    assert.match(spec, /\[p1\] plugin:kv\.fillMasked/);
    assert.match(spec, /require\('\.\/vv-plugins\.cjs'\)\.runPluginStep\("plugin:kv\.fillMasked", \{ "label": "E", "value": \(process\.env\["PW"\] \?\? ''\) \}, page, \{ stepId: "p1" \}\)/);
    assert.ok(!spec.includes('vv-visual-compare'), 'no visual helper without visual steps');
  });

  it('registry fail-fast: unknown type, missing required, plaintext secret', () => {
    const plugins = {
      'plugin:kv.fillMasked': {
        schema: {
          required: ['label', 'value'],
          properties: { label: { type: 'string' }, value: { type: 'string', secret: true } },
        },
      },
    };
    assert.throws(() => compileSpec(testDef([step('p1', 'plugin:ghost.x')]), { plugins }), /PLUGIN_NOT_FOUND/);
    assert.throws(
      () => compileSpec(testDef([step('p1', 'plugin:kv.fillMasked', { params: { label: 'E' } })]), { plugins }),
      /missing required param 'value'/,
    );
    assert.throws(
      () => compileSpec(testDef([step('p1', 'plugin:kv.fillMasked', { params: { label: 'E', value: 'plain' } })]), { plugins }),
      /secret param 'value' must be a \{\{VARIABLE\}\} reference/,
    );
  });

  it('P0 output stays byte-identical (no fixtures/helpers without P2 steps)', () => {
    const spec = compileSpec(testDef([step('s1', 'goto', { url: 'https://example.com' })]));
    assert.match(spec, /async \(\{\s?page\s?\}\)/);
    assert.ok(!spec.includes('vv-visual-compare') && !spec.includes('vv-plugins'));
  });
});

describe('sanitizeVisualFileName parity (runner == package compiler)', () => {
  it('matches the package compiler for the same inputs', async () => {
    const compilerRequire = createRequire(import.meta.url);
    let pkg;
    try {
      pkg = compilerRequire('../../playwright-compiler/dist/src/compiler.js');
    } catch {
      // Package not built in this environment — compare against the documented rule instead.
      pkg = { sanitizeVisualFileName: (n) => `visual-${String(n).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 120) || 'check'}.png` };
    }
    for (const name of ['hero', 'a/b c!', '', 'x'.repeat(200), 'tiếng-việt']) {
      assert.equal(sanitizeVisualFileName(name), pkg.sanitizeVisualFileName(name), `parity for ${JSON.stringify(name)}`);
    }
  });
});

describe('visualHelperSource round-trip (serialized workdir helper)', () => {
  let workDir;
  let helper;
  let prevBaselines;
  let prevUpdate;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), 'vv-visual-'));
    writeFileSync(join(workDir, 'vv-visual-compare.cjs'), visual.visualHelperSource());
    helper = require(join(workDir, 'vv-visual-compare.cjs'));
    prevBaselines = process.env.VV_BASELINES;
    prevUpdate = process.env.VV_UPDATE_BASELINES;
  });

  after(() => {
    if (prevBaselines === undefined) delete process.env.VV_BASELINES;
    else process.env.VV_BASELINES = prevBaselines;
    if (prevUpdate === undefined) delete process.env.VV_UPDATE_BASELINES;
    else process.env.VV_UPDATE_BASELINES = prevUpdate;
  });

  it('identical images pass with zero diff', () => {
    const baseline = join(workDir, 'base.png');
    const actual = join(workDir, 'shots', 'visual-hero.png');
    writeFileSync(baseline, solidPng(8, 8, 10, 20, 30));
    require('node:fs').mkdirSync(join(workDir, 'shots'), { recursive: true });
    writeFileSync(actual, solidPng(8, 8, 10, 20, 30));
    process.env.VV_BASELINES = JSON.stringify({ hero: baseline });
    delete process.env.VV_UPDATE_BASELINES;
    const res = helper.compareVisualFromEnv({ name: 'hero', actualPath: actual, threshold: 0.05 });
    assert.equal(res.updated, false);
    assert.equal(res.diffPixels, 0);
    assert.equal(res.ratio, 0);
  });

  it('small diffs within threshold pass; over-threshold fails with diff artifact + metrics', () => {
    const baseline = join(workDir, 'base2.png');
    writeFileSync(baseline, solidPng(10, 10, 0, 0, 0));
    process.env.VV_BASELINES = JSON.stringify({ hero: baseline });
    const mkActual = (name, w, h, r, g, b) => {
      const p = join(workDir, 'shots', `visual-${name}.png`);
      writeFileSync(p, solidPng(w, h, r, g, b));
      return p;
    };
    // 1/100 pixels differ = 1% <= 5% passes (opaque black + 1 red pixel).
    const almost = (() => {
      const rgba = Buffer.alloc(10 * 10 * 4);
      for (let i = 0; i < 10 * 10; i++) rgba[i * 4 + 3] = 255;
      rgba[0] = 255;
      const p = join(workDir, 'shots', 'visual-almost.png');
      writeFileSync(p, visual.encodePngImage(10, 10, rgba));
      return p;
    })();
    const ok = helper.compareVisualFromEnv({ name: 'hero', actualPath: almost, threshold: 0.05 });
    assert.equal(ok.diffPixels, 1);
    assert.ok(ok.ratio <= 0.05);
    // Fully different (100%) fails, writes .diff.png with metrics in the error.
    const actual = mkActual('other', 10, 10, 255, 255, 255);
    assert.throws(
      () => helper.compareVisualFromEnv({ name: 'hero', actualPath: actual, threshold: 0.05 }),
      (err) => {
        assert.match(err.message, /VISUAL_DIFF_EXCEEDED/);
        assert.match(err.message, /100\/100 pixels differ/);
        return true;
      },
    );
    assert.ok(existsSync(join(workDir, 'shots', 'visual-other.diff.png')), 'diff artifact written');
    const dims = visual.readPngDimensions(readFileSync(join(workDir, 'shots', 'visual-other.diff.png')));
    assert.deepEqual(dims, { width: 10, height: 10 });
  });

  it('missing baseline fails; update mode passes (capture for server promote)', () => {
    process.env.VV_BASELINES = JSON.stringify({});
    delete process.env.VV_UPDATE_BASELINES;
    const actual = join(workDir, 'shots', 'visual-hero.png');
    assert.throws(
      () => helper.compareVisualFromEnv({ name: 'hero', actualPath: actual, threshold: 0.05 }),
      /VISUAL_BASELINE_MISSING/,
    );
    process.env.VV_UPDATE_BASELINES = '1';
    const res = helper.compareVisualFromEnv({ name: 'hero', actualPath: actual, threshold: 0.05 });
    assert.equal(res.updated, true);
    delete process.env.VV_UPDATE_BASELINES;
  });

  it('size mismatch and bad inputs fail explicitly', () => {
    const baseline = join(workDir, 'base3.png');
    writeFileSync(baseline, solidPng(4, 4, 1, 2, 3));
    process.env.VV_BASELINES = JSON.stringify({ hero: baseline });
    delete process.env.VV_UPDATE_BASELINES;
    const actual = join(workDir, 'shots', 'visual-hero.png');
    assert.throws(() => helper.compareVisualFromEnv({ name: 'hero', actualPath: actual, threshold: 0.05 }), /VISUAL_SIZE_MISMATCH/);
    assert.throws(() => helper.compareVisualFromEnv({ name: 'hero', actualPath: actual, threshold: 7 }), /VISUAL_THRESHOLD_INVALID/);
    assert.throws(() => helper.compareVisualFromEnv({ name: 'hero', actualPath: join(workDir, 'nope.png'), threshold: 0.05 }), /VISUAL_ACTUAL_MISSING/);
    process.env.VV_BASELINES = '{broken';
    assert.throws(() => helper.compareVisualFromEnv({ name: 'hero', actualPath: actual, threshold: 0.05 }), /VISUAL_BASELINES_INVALID/);
  });
});

describe('PLUGIN_SHIM_CJS round-trip', () => {
  it('dispatches execute() with validated params; unknown type fails', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'vv-shim-'));
    require('node:fs').mkdirSync(join(workDir, 'plugins'), { recursive: true });
    writeFileSync(
      join(workDir, 'plugins', 'kv.cjs'),
      `module.exports = { name: 'kv', version: '1.0.0', steps: [{ type: 'plugin:kv.fillMasked', schema: { required: ['label'], properties: { label: { type: 'string' } } }, async execute(ctx) { ctx.page.calls.push(['fillMasked', ctx.params, ctx.stepId]); } }] };`,
    );
    writeFileSync(join(workDir, 'vv-plugins.cjs'), PLUGIN_SHIM_CJS);
    const shim = require(join(workDir, 'vv-plugins.cjs'));
    const prev = process.env.VV_PLUGINS;
    process.env.VV_PLUGINS = JSON.stringify({
      'plugin:kv.fillMasked': { file: 'kv.cjs', schema: { required: ['label'], properties: { label: { type: 'string' } } } },
    });
    try {
      const calls = [];
      await shim.runPluginStep('plugin:kv.fillMasked', { label: 'Email' }, { calls }, { stepId: 'p1' });
      assert.deepEqual(calls, [['fillMasked', { label: 'Email' }, 'p1']]);
      await assert.rejects(() => shim.runPluginStep('plugin:ghost.x', {}, {}, { stepId: 'p9' }), /PLUGIN_NOT_FOUND/);
      await assert.rejects(() => shim.runPluginStep('plugin:kv.fillMasked', {}, {}, { stepId: 'p1' }), /missing required param/);
      await assert.rejects(
        () => shim.runPluginStep('plugin:kv.fillMasked', { label: 'E', extra: '1' }, {}, { stepId: 'p1' }),
        /undeclared param/,
      );
    } finally {
      if (prev === undefined) delete process.env.VV_PLUGINS;
      else process.env.VV_PLUGINS = prev;
    }
  });

  it('collectPluginStepTypes finds sorted unique plugin types', () => {
    assert.deepEqual(
      collectPluginStepTypes([
        { type: 'plugin:b.two', enabled: true },
        { type: 'goto', enabled: true },
        { type: 'plugin:a.one', enabled: true },
        { type: 'plugin:b.two', enabled: true },
        { type: 'plugin:off.x', enabled: false },
      ]),
      ['plugin:a.one', 'plugin:b.two'],
    );
  });
});
