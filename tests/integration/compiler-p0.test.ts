/**
 * Integration: P0 compiler covers EVERY step type; output parses; redaction green.
 * Strategy: 12-testing/test-strategy.md (Release gate P0: compiler coverage for
 * every P0 step; secret redaction tests green) + acceptance (deterministic
 * compile to valid Playwright TS; runnable under upstream @playwright/test).
 *
 * Run: npx tsx --test tests/integration/compiler-p0.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import {
  compileTest,
  SUPPORTED_STEP_TYPES,
  UnsupportedStepError,
} from '../../packages/playwright-compiler/src/compiler.js';
import {
  compileValueExpression,
  extractVariableNames,
  hasVariable,
  redactSecrets,
} from '../../packages/playwright-compiler/src/variables.js';
import { compileDefinition as serverCompile } from '../../apps/server/src/routes/compiler.js';
import { minimalStepFor } from './helpers.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function defWithStep(type: string) {
  const step =
    type === 'dragAndDrop'
      ? { id: 's9', type, enabled: true }
      : { ...minimalStepFor(type), enabled: true };
  return {
    schemaVersion: '1.0',
    id: 'test_p0_cover',
    projectId: 'p_p0',
    name: 'P0 coverage',
    browser: 'chromium',
    steps: [step],
  } as never;
}

/** Assert generated TS parses: transpile -> vm.Script syntax check. */
async function assertParses(code: string, label: string): Promise<void> {
  const ts = await import('typescript');
  const js = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  new Script(js, { filename: `${label}.spec.js` });
}

describe('P0 release gate: compiler covers every step type', () => {
  it(`all ${SUPPORTED_STEP_TYPES.length} SUPPORTED_STEP_TYPES compile (none skipped, none TODO)`, async () => {
    assert.ok(SUPPORTED_STEP_TYPES.length >= 27, 'P0 catalog must stay complete');
    for (const type of SUPPORTED_STEP_TYPES) {
      const out = compileTest(defWithStep(type));
      assert.ok(out.includes('await test.step('), `${type}: must preserve test.step() wrapper`);
      assert.ok(!out.includes('TODO'), `${type}: must not contain TODO placeholders`);
      assert.ok(!out.includes('Unsupported'), `${type}: must not contain error text`);
      await assertParses(out, type);
    }
  });

  it('unsupported step fails explicitly (never silently skipped)', () => {
    assert.throws(() => compileTest(defWithStep('dragAndDrop')), UnsupportedStepError);
  });

  it('server preview compiler agrees on core steps and rejects unknown ones', () => {
    for (const type of ['goto', 'click', 'fill', 'assertVisible', 'assertText']) {
      const code = serverCompile({ steps: [minimalStepFor(type)], name: 'srv' } as never);
      assert.ok(code.includes('@playwright/test'), `${type}: server compile works`);
    }
    assert.throws(
      () => serverCompile({ steps: [{ id: 'sx', type: 'dragAndDrop', enabled: true }], name: 'srv' } as never),
      (e: unknown) => (e as { code?: string }).code === 'COMPILER_UNSUPPORTED_STEP',
    );
  });
});

describe('determinism + golden login example', () => {
  it('same input -> byte-identical output; login example compiles to runnable spec', async () => {
    const raw = readFileSync(resolve(ROOT, 'examples', 'login-test.json'), 'utf8');
    const a = compileTest(JSON.parse(raw) as never);
    const b = compileTest(JSON.parse(raw) as never);
    assert.equal(a, b);
    assert.match(a, /page\.getByLabel\('Email'\)\.fill\(process\.env\.ADMIN_EMAIL!\)/);
    assert.match(a, /page\.getByRole\('button', \{ name: 'Login' \}\)\.click\(\)/);
    assert.match(a, /toBeVisible/);
    await assertParses(a, 'login');
  });
});

describe('secret redaction (release gate: redaction xanh)', () => {
  it('{{VAR}} compiles to process.env lookups; secrets never inline', () => {
    assert.equal(compileValueExpression('{{ADMIN_PASSWORD}}'), 'process.env.ADMIN_PASSWORD!');
    assert.equal(
      compileValueExpression('{{BASE_URL}}/fixture/login'),
      '`${process.env.BASE_URL}/fixture/login`',
    );
    assert.deepEqual(extractVariableNames('{{A}}/x/{{B}}'), ['A', 'B']);
    assert.equal(hasVariable('plain'), false);
  });

  it('redactSecrets scrubs values and lookup shapes from logs', () => {
    const env = { ADMIN_PASSWORD: 's3cr3t-pw', BASE_URL: 'http://internal:9999' };
    const log = 'login with s3cr3t-pw at http://internal:9999 via process.env.ADMIN_PASSWORD';
    assert.equal(
      redactSecrets(log, ['ADMIN_PASSWORD', 'BASE_URL'], env),
      'login with *** at *** via process.env.***',
    );
  });

  it('sensitive fill output references the variable, never the secret', () => {
    const out = compileTest({
      schemaVersion: '1.0',
      id: 't_sec',
      projectId: 'p',
      name: 'sec',
      browser: 'chromium',
      steps: [{
        id: 's1', type: 'fill', enabled: true,
        target: { primary: { strategy: 'label', value: 'Password' } },
        value: '{{ADMIN_PASSWORD}}', sensitive: true,
      }],
    } as never);
    assert.match(out, /process\.env\.ADMIN_PASSWORD!/);
  });
});
