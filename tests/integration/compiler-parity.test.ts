/**
 * Integration: compiler parity — the canonical package compiler and the
 * runner's execution-dialect compiler must cover the SAME steps in the SAME
 * order (06-compiler + 07-runner). Known dialect differences are documented,
 * not asserted away:
 * - package emits `test.step('<name>')`; runner emits `test.step('[<id>] <name>')`
 *   so the reporter can recover step ids.
 * - both must succeed/fail on exactly the same step sets (no silent skips).
 *
 * Run: npx tsx --test tests/integration/compiler-parity.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileTest } from '../../packages/playwright-compiler/src/compiler.js';
import { compileSpec } from '../../apps/runner/src/compile.js';
import { minimalStepFor } from './helpers.js';
import { P0_STEP_TYPES } from '../../packages/test-model/src/types.js';

function defWith(types: string[]) {
  return {
    schemaVersion: '1.0' as const,
    id: 'test_parity',
    projectId: 'project_parity',
    name: 'Parity check',
    browser: 'chromium' as const,
    // Unique human names: the package compiler titles steps by name (no ids),
    // the runner dialect prefixes [id] — both must preserve definition order.
    steps: types.map((t) => ({ ...minimalStepFor(t), id: `s_${t}`, name: `parity-name-${t}`, enabled: true })),
  };
}

describe('compiler parity (package vs runner dialect)', () => {
  it('covers every P0 step in both compilers, same order', async () => {
    const { transpileModule, ModuleKind, ScriptTarget } = await import('typescript');
    for (const type of P0_STEP_TYPES) {
      const def = defWith([type]);
      const fromPackage = compileTest(def as never);
      const fromRunner = compileSpec(def as never);
      assert.ok(fromPackage.length > 0 && fromRunner.length > 0, `${type}: both emit code`);
      // Both outputs must transpile (valid TypeScript).
      for (const [who, code] of [['package', fromPackage], ['runner', fromRunner]] as const) {
        const out = transpileModule(code, {
          compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
        });
        assert.ok(!out.diagnostics?.length, `${type} (${who}): transpiles cleanly`);
      }
    }
    // Full-catalog order preservation: markers appear in definition order.
    // Package titles use step names, runner titles use [id] — check each in
    // its own dialect.
    const full = defWith([...P0_STEP_TYPES]);
    const pkg = compileTest(full as never);
    const run = compileSpec(full as never);
    let pkgIdx = 0;
    let runIdx = 0;
    for (const type of P0_STEP_TYPES) {
      const nameMarker = `parity-name-${type}`;
      const idMarker = `s_${type}`;
      const pi = pkg.indexOf(nameMarker, pkgIdx);
      const ri = run.indexOf(idMarker, runIdx);
      assert.ok(pi >= 0, `package output contains ${nameMarker}`);
      assert.ok(ri >= 0, `runner output contains ${idMarker}`);
      pkgIdx = pi + 1;
      runIdx = ri + 1;
    }
  });

  it('both fail explicitly on the same unknown step (never silently skip)', async () => {
    const def = defWith(['goto']);
    (def.steps as Array<Record<string, unknown>>).push({ id: 's_bogus', type: 'nope-not-a-step', enabled: true });
    assert.throws(() => compileTest(def as never), /nope-not-a-step|unsupported/i);
    assert.throws(() => compileSpec(def as never), /nope-not-a-step|unsupported/i);
  });

  it('documents the dialect contract: runner prefixes [stepId], package does not', () => {
    const def = defWith(['click']);
    const pkg = compileTest(def as never);
    const run = compileSpec(def as never);
    assert.ok(run.includes('[s_click]'), 'runner titles carry [id] for reporter mapping');
    assert.ok(!pkg.includes('[s_click]'), 'package titles stay human-readable');
    assert.ok(pkg.includes('Click') || pkg.includes('click'), 'package keeps a readable name');
  });
});
