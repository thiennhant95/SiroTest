/**
 * P2 healing-probe compile tests (node:test, no browser needed).
 * Run: pnpm --filter @playwright-studio/runner build && pnpm --filter @playwright-studio/runner test
 *
 * Covers: P0 output byte-identical without the flag (primary-only, no probe
 * markers), probe wrapper present only with { healingProbe: true } and only
 * on locator-bearing steps that carry alternatives, original error always
 * rethrown, deterministic output.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compileSpec, compileConfig } = require('../dist/compile.js');

const step = (id, type, fields = {}) => ({ id, type, enabled: true, ...fields });
const testDef = (steps) => ({
  schemaVersion: '1.0', id: 't_heal', projectId: 'p', name: 'Healing test', browser: 'chromium', steps,
});
const clickWithAlts = () => step('s2', 'click', {
  name: 'Click more',
  target: {
    primary: { strategy: 'css', value: '.missing' },
    alternatives: [{ strategy: 'text', value: 'More information...' }],
  },
});

describe('healing probe codegen', () => {
  it('P0 output has no probe markers without the flag', () => {
    const spec = compileSpec(testDef([
      step('s1', 'goto', { name: 'Go', url: 'https://example.com' }),
      clickWithAlts(),
    ]), {});
    assert.ok(!spec.includes('VV_HEALING_PATH'), 'no healing env ref without flag');
    assert.ok(!spec.includes('vvWinner_'), 'no probe variables without flag');
  });

  it('emits probe wrapper with the flag on locator-bearing steps with alternatives', () => {
    const spec = compileSpec(testDef([
      step('s1', 'goto', { name: 'Go', url: 'https://example.com' }),
      clickWithAlts(),
    ]), { healingProbe: true });
    assert.ok(spec.includes('VV_HEALING_PATH'), 'evidence path referenced');
    assert.ok(spec.includes("getByText(\"More information...\")"), 'alternative expr emitted');
    assert.ok(spec.includes('throw vvErr_s2;'), 'original error rethrown');
    // goto has no alternatives -> unwrapped
    assert.ok(!spec.includes('vvErr_s1'), 'steps without alternatives stay unwrapped');
  });

  it('skips steps without alternatives even with the flag', () => {
    const spec = compileSpec(testDef([
      step('s1', 'click', { name: 'Plain', target: { primary: { strategy: 'css', value: '.x' } } }),
    ]), { healingProbe: true });
    assert.ok(!spec.includes('VV_HEALING_PATH'));
  });

  it('is deterministic with the flag on', () => {
    const def = testDef([clickWithAlts()]);
    assert.equal(compileSpec(def, { healingProbe: true }), compileSpec(def, { healingProbe: true }));
  });

  it('reserves probe headroom only with the flag (actionTimeout + step timeout)', () => {
    const baseConfig = {
      browser: 'chromium', reporterPath: '/tmp/reporter.js', runId: 'run1',
      trace: 'off', screenshot: 'off', video: 'off', outputDir: '/tmp/out',
    };
    const plain = compileConfig(baseConfig);
    assert.ok(!plain.includes('actionTimeout'), 'P0 config byte-identical without flag');
    const healing = compileConfig({ ...baseConfig, healingActionTimeoutMs: 60000 });
    assert.ok(healing.includes('actionTimeout: 60000'), 'primary capped at plain timeout');
    const timed = step('s9', 'click', {
      name: 'Timed', timeoutMs: 5000,
      target: {
        primary: { strategy: 'css', value: '.missing' },
        alternatives: [{ strategy: 'text', value: 'X' }],
      },
    });
    const noFlag = compileSpec(testDef([timed]), {});
    assert.ok(noFlag.includes('{ timeout: 5000 }'), 'P0 step timeout untouched');
    const withFlag = compileSpec(testDef([timed]), { healingProbe: true });
    assert.ok(withFlag.includes('{ timeout: 20000 }'), 'step timeout extended by 15000 headroom');
  });
});
