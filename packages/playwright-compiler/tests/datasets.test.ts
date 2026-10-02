/**
 * P1 data-driven tests for @vietvang/playwright-compiler (node:test).
 * Covers: `{{row.NAME}}` interpolation, dataset loop emission, P0
 * byte-identical output without a dataset, explicit failure for row refs
 * without a dataset / unknown datasetId, and the plaintext-rows secret hint.
 *
 * Run: `npm run build && node --test dist/tests/datasets.test.js`
 * (also wired into `npm test`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  compileTest,
  DATASET_SECRET_NOTE,
  InvalidDefinitionError,
  type DataSet,
  type TestDefinition,
  type TestStep,
} from '../src/compiler';
import {
  compileValueExpression,
  extractRowNames,
  hasRowReference,
  hasVariable,
} from '../src/variables';

function step(id: string, type: string, fields: Record<string, unknown> = {}): TestStep {
  return { id, type, enabled: true, ...fields };
}

function datasetsDef(extra: Partial<TestDefinition> = {}): TestDefinition {
  const ds: DataSet = {
    id: 'ds_users',
    name: 'Users',
    rows: [
      { EMAIL: 'a@example.com', CITY: 'Hanoi' },
      { EMAIL: 'b@example.com', CITY: 'Saigon' },
    ],
  };
  return {
    schemaVersion: '1.0',
    id: 'test_dd',
    projectId: 'project_demo',
    name: 'Data-driven test',
    browser: 'chromium',
    datasets: [ds],
    steps: [
      step('s1', 'fill', {
        target: { primary: { strategy: 'label', value: 'Email' } },
        value: '{{row.EMAIL}}',
      }),
      step('s2', 'assertText', {
        target: { primary: { strategy: 'text', value: 'Hi' } },
        expected: 'Hello {{row.CITY}}!',
      }),
    ],
    ...extra,
  };
}

describe('{{row.NAME}} interpolation', () => {
  it('whole-string row ref compiles to a runtime row lookup with empty fallback', () => {
    assert.equal(compileValueExpression('{{row.EMAIL}}'), `(row['EMAIL'] ?? '')`);
    assert.equal(compileValueExpression('{{  row.CITY  }}'), `(row['CITY'] ?? '')`);
  });

  it('mixed text compiles env vars + row lookups into one template literal', () => {
    assert.equal(
      compileValueExpression('{{BASE_URL}}/u/{{row.EMAIL}}'),
      '`${process.env.BASE_URL}/u/${(row[\'EMAIL\'] ?? \'\')}`',
    );
  });

  it('plain text still compiles to an escaped literal (no row in scope)', () => {
    assert.equal(compileValueExpression('hello'), `'hello'`);
  });

  it('row helpers: extractRowNames / hasRowReference (env helpers untouched)', () => {
    assert.deepEqual(extractRowNames('{{row.A}}/x/{{row.B}}/{{row.A}}'), ['A', 'B']);
    assert.equal(hasRowReference('no refs'), false);
    assert.equal(hasRowReference('{{row.X}}'), true);
    // Row refs are NOT env variables: secret plumbing must not treat them as such.
    assert.equal(hasVariable('{{row.X}}'), false);
  });

  it('hostile column-adjacent text is escaped, never breaks the literal', () => {
    const out = compileValueExpression("a'b`c${evil} {{row.X}}");
    // Backticks / ${ openers are escaped so user text can never break out of
    // the generated template literal (plain ' needs no escaping there).
    assert.ok(out.includes('\\`'), `backtick escaped: ${out}`);
    assert.ok(out.includes('\\${evil}'), `template injection escaped: ${out}`);
    assert.ok(out.includes(`(row['X'] ?? '')`), `row lookup kept: ${out}`);
  });
});

describe('dataset loop emission', () => {
  it('wraps steps in a deterministic for loop reading VV_DATASET_ROWS', () => {
    const out = compileTest(datasetsDef(), { datasetId: 'ds_users' });
    assert.match(out, /const VV_ROWS: Array<Record<string, string>> = JSON\.parse\(process\.env\.VV_DATASET_ROWS \?\? '\[\]'\);/);
    assert.match(out, /for \(let _vvIteration = 0; _vvIteration < \(VV_ROWS\.length \? VV_ROWS\.length : 1\); _vvIteration\+\+\) \{/);
    assert.match(out, /const row: Record<string, string> = VV_ROWS\[_vvIteration\] \?\? \{\};/);
    // Empty dataset still runs once with an empty row (never silently skips).
    assert.ok(out.includes('? VV_ROWS.length : 1)'));
  });

  it('preserves test.step names with an iteration suffix, keeps row lookups', () => {
    const out = compileTest(datasetsDef(), { datasetId: 'ds_users' });
    assert.ok(out.includes('await test.step(`Fill'), `step wrapper kept: ${out}`);
    assert.ok(out.includes('#${_vvIteration + 1}`'), 'iteration suffix present');
    assert.ok(out.includes(`(row['EMAIL'] ?? '')`), 'row lookup present');
    assert.ok(out.includes(`(row['CITY'] ?? '')`), 'mixed row lookup present');
  });

  it('same definition + datasetId is byte-identical across compiles', () => {
    const a = compileTest(datasetsDef(), { datasetId: 'ds_users' });
    const b = compileTest(datasetsDef(), { datasetId: 'ds_users' });
    assert.equal(a, b);
  });

  it('dataset output embeds the plaintext-rows secret note', () => {
    const out = compileTest(datasetsDef(), { datasetId: 'ds_users' });
    assert.ok(out.includes(DATASET_SECRET_NOTE), 'generated code carries the secret hint');
  });

  it('unknown datasetId fails explicitly', () => {
    assert.throws(
      () => compileTest(datasetsDef(), { datasetId: 'ds_nope' }),
      (e: unknown) => e instanceof InvalidDefinitionError && /Unknown datasetId/.test(e.message),
    );
  });

  it('row refs without a dataset fail explicitly (no dangling `row`)', () => {
    assert.throws(
      () => compileTest(datasetsDef()),
      (e: unknown) => e instanceof InvalidDefinitionError && /\{\{row\./.test(e.message),
    );
  });

  it('disabled steps stay commented inside the loop', () => {
    const def = datasetsDef({
      steps: [{ ...step('s0', 'reload'), enabled: false }, ...datasetsDef().steps],
    });
    const out = compileTest(def, { datasetId: 'ds_users' });
    assert.ok(out.includes('    // skipped disabled step s0 (reload)'));
  });
});

describe('P0 compatibility', () => {
  function findRepoRoot(): string {
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, 'examples', 'login-test.json'))) return dir;
      dir = path.dirname(dir);
    }
    throw new Error('Could not locate repo root (examples/login-test.json not found)');
  }

  it('no dataset selected -> byte-identical P0 output (golden login example)', () => {
    const root = findRepoRoot();
    const raw = fs.readFileSync(path.join(root, 'examples', 'login-test.json'), 'utf8');
    const a = compileTest(JSON.parse(raw) as TestDefinition);
    const b = compileTest(JSON.parse(raw) as TestDefinition, {});
    assert.equal(a, b);
    // Golden shape untouched: no loop keywords leak into P0 output.
    assert.ok(!a.includes('_vvIteration'), 'P0 output has no iteration loop');
    assert.ok(!a.includes('VV_DATASET_ROWS'), 'P0 output has no dataset env read');
  });

  it('datasets present but none selected -> P0 output, row-free steps compile', () => {
    const def = datasetsDef({
      steps: [step('s1', 'reload')],
    });
    const out = compileTest(def);
    assert.ok(!out.includes('_vvIteration'));
    assert.ok(out.includes('await page.reload();'));
  });
});

describe('secret hint contract', () => {
  it('DATASET_SECRET_NOTE tells users to keep secrets in variables', () => {
    assert.match(DATASET_SECRET_NOTE, /plaintext/i);
    assert.match(DATASET_SECRET_NOTE, /\{\{VARIABLES\}\}/);
  });

  it('a sensitive fill from {{row.*}} is rejected (not a {{VARIABLE}})', () => {
    const def = datasetsDef({
      steps: [
        step('s1', 'fill', {
          target: { primary: { strategy: 'label', value: 'Password' } },
          value: '{{row.PASSWORD}}',
          sensitive: true,
        }),
      ],
    });
    assert.throws(
      () => compileTest(def, { datasetId: 'ds_users' }),
      (e: unknown) => e instanceof InvalidDefinitionError && /\{\{VARIABLE\}\}/.test(e.message),
    );
  });
});
