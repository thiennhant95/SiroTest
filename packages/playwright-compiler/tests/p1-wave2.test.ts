/**
 * P1 wave-2 step-engine tests for @vietvang/playwright-compiler (node:test).
 * Covers: upload / download (target + url-only) / newTab+closeTab page
 * tracking / handleDialog / apiRequest, plus explicit-failure edges
 * (closeTab on last tab, download with neither target nor url, apiRequest
 * expectedStatus mismatch shape, newTab standalone naming) and the P0
 * byte-identical guarantee (no wave-2 steps -> output unchanged).
 *
 * Run: `npm run build && node --test dist/tests/p1-wave2.test.js`
 * (also wired into `npm test`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  compileStepBody,
  compileTest,
  InvalidDefinitionError,
  UnsupportedStepError,
  type TestDefinition,
  type TestStep,
} from '../src/compiler';
import type { LocatorSpec } from '../src/locatorToExpression';

function step(id: string, type: string, fields: Record<string, unknown> = {}): TestStep {
  return { id, type, enabled: true, ...fields };
}

function defWithSteps(steps: TestStep[], extra: Partial<TestDefinition> = {}): TestDefinition {
  return {
    schemaVersion: '1.0',
    id: 'test_wave2',
    projectId: 'project_demo',
    name: 'Wave2 test',
    browser: 'chromium',
    steps,
    ...extra,
  };
}

const T = (primary: LocatorSpec['primary']) => ({ primary });

/** Walk up from the compiled test dir to find the repo `examples/` folder. */
function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'examples', 'login-test.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('Could not locate repo root (examples/login-test.json not found)');
}

describe('upload', () => {
  it('compiles to setInputFiles with a run-time FILE_PATHS lookup', () => {
    const out = compileTest(
      defWithSteps([
        step('u1', 'upload', { target: T({ strategy: 'label', value: 'File' }), fileId: 'file_abc' }),
      ]),
    );
    assert.ok(out.includes(`setInputFiles(vvFile)`), out);
    assert.ok(out.includes('VV_FILE_PATHS'), out);
    assert.ok(out.includes(`'file_abc'`), out);
    assert.ok(out.includes('await test.step('), 'keeps test.step() wrapper');
  });

  it('missing fileId fails explicitly', () => {
    assert.throws(
      () => compileTest(defWithSteps([step('u1', 'upload', { target: T({ strategy: 'label', value: 'File' }) })])),
      InvalidDefinitionError,
    );
  });

  it('missing target fails explicitly', () => {
    assert.throws(
      () => compileTest(defWithSteps([step('u1', 'upload', { fileId: 'f1' })])),
      InvalidDefinitionError,
    );
  });
});

describe('download', () => {
  it('target variant: waitForEvent + click + saveAs', () => {
    const out = compileTest(
      defWithSteps([
        step('d1', 'download', { target: T({ strategy: 'role', role: 'link', name: 'Report' }), saveAs: 'report.csv' }),
      ]),
    );
    assert.ok(out.includes(`waitForEvent('download')`), out);
    assert.ok(out.includes('.click();'), out);
    assert.ok(out.includes(`await download.saveAs('report.csv');`), out);
  });

  it('target variant without saveAs uses suggestedFilename()', () => {
    const out = compileTest(
      defWithSteps([step('d1', 'download', { target: T({ strategy: 'text', value: 'Export' }) })]),
    );
    assert.ok(out.includes('download.suggestedFilename()'), out);
  });

  it('url-only variant: page.evaluate(fetch) + fs.writeFile (cookies apply)', () => {
    const out = compileTest(
      defWithSteps([step('d1', 'download', { url: '{{BASE_URL}}/export', saveAs: 'out.csv' })]),
    );
    assert.ok(out.includes('.evaluate(async (vvUrl: string)'), out);
    assert.ok(out.includes('fetch(vvUrl)'), out);
    assert.ok(out.includes(`process.env.BASE_URL`), out);
    assert.ok(out.includes(`writeFile('out.csv'`), out);
  });

  it('neither target nor url fails explicitly', () => {
    assert.throws(
      () => compileStepBody(step('d1', 'download', { saveAs: 'x.csv' })),
      InvalidDefinitionError,
    );
    assert.throws(
      () => compileTest(defWithSteps([step('d1', 'download', {})])),
      InvalidDefinitionError,
    );
  });
});

describe('newTab / closeTab page tracking', () => {
  it('newTab emits context.newPage + goto and later steps use page2', () => {
    const out = compileTest(
      defWithSteps([
        step('s1', 'goto', { url: 'https://example.com' }),
        step('t1', 'newTab', { url: 'https://example.com/docs' }),
        step('s2', 'click', { target: T({ strategy: 'role', role: 'button', name: 'Save' }) }),
      ]),
    );
    assert.ok(out.includes('async ({ page, context })'), out);
    assert.ok(out.includes('const page2 = await context.newPage();'), out);
    assert.ok(out.includes(`await page2.goto('https://example.com/docs');`), out);
    assert.ok(out.includes(`page2.getByRole('button', { name: 'Save' })`), out);
    // Pre-tab steps still use the fixture page.
    assert.ok(out.includes(`await page.goto('https://example.com');`), out);
  });

  it('closeTab closes the current tab and following steps use the previous one', () => {
    const out = compileTest(
      defWithSteps([
        step('t1', 'newTab', {}),
        step('s2', 'click', { target: T({ strategy: 'text', value: 'Hi' }) }),
        step('c1', 'closeTab', {}),
        step('s3', 'reload', {}),
      ]),
    );
    assert.ok(out.includes('await page2.close();'), out);
    assert.ok(out.includes('await page.reload();'), out);
  });

  it('closing the last remaining tab fails explicitly', () => {
    assert.throws(
      () => compileTest(defWithSteps([step('c1', 'closeTab', {})])),
      (e: unknown) => e instanceof InvalidDefinitionError && /last remaining tab/.test((e as Error).message),
    );
  });

  it('newTab via compileStepBody requires a deterministic name', () => {
    assert.throws(() => compileStepBody(step('t1', 'newTab', {})), InvalidDefinitionError);
  });

  it('assertions follow the current tab', () => {
    const out = compileTest(
      defWithSteps([
        step('t1', 'newTab', {}),
        step('a1', 'assertTitle', { expected: 'Docs' }),
      ]),
    );
    assert.ok(out.includes('await expect(page2).toHaveTitle('), out);
  });
});

describe('handleDialog', () => {
  it('accept without promptText registers a one-time accept handler', () => {
    const out = compileTest(
      defWithSteps([
        step('h1', 'handleDialog', { action: 'accept' }),
        step('s1', 'click', { target: T({ strategy: 'text', value: 'Delete' }) }),
      ]),
    );
    assert.ok(
      out.includes(`page.once('dialog', async (dialog) => { await dialog.accept(); });`),
      out,
    );
  });

  it('accept with promptText fills it (supports {{VAR}})', () => {
    const out = compileTest(
      defWithSteps([
        step('h1', 'handleDialog', { action: 'accept', promptText: '{{PROMPT_DEFAULT}}' }),
        step('s1', 'click', { target: T({ strategy: 'text', value: 'Rename' }) }),
      ]),
    );
    assert.ok(out.includes('process.env.PROMPT_DEFAULT'), out);
  });

  it('dismiss registers a dismiss handler', () => {
    const out = compileTest(
      defWithSteps([
        step('h1', 'handleDialog', { action: 'dismiss' }),
        step('s1', 'reload', {}),
      ]),
    );
    assert.ok(
      out.includes(`page.once('dialog', async (dialog) => { await dialog.dismiss(); });`),
      out,
    );
  });

  it('bad action fails explicitly', () => {
    assert.throws(
      () => compileTest(defWithSteps([step('h1', 'handleDialog', { action: 'maybe' })])),
      InvalidDefinitionError,
    );
  });

  it('uses the current tab handle after newTab', () => {
    const out = compileTest(
      defWithSteps([
        step('t1', 'newTab', {}),
        step('h1', 'handleDialog', { action: 'dismiss' }),
        step('s1', 'reload', {}),
      ]),
    );
    assert.ok(out.includes(`page2.once('dialog'`), out);
  });
});

describe('apiRequest', () => {
  it('emits a request-fixture call with headers/body templating', () => {
    const out = compileTest(
      defWithSteps([
        step('a1', 'apiRequest', {
          method: 'POST',
          url: '{{BASE_URL}}/api/login',
          headers: { 'X-Token': '{{API_TOKEN}}', 'Content-Type': 'application/json' },
          body: '{"u":"a"}',
          expectedStatus: 200,
          saveAs: 'LOGIN_RESP',
        }),
      ]),
    );
    assert.ok(out.includes('async ({ page, request })'), out);
    assert.ok(out.includes('await request.post('), out);
    assert.ok(out.includes('process.env.BASE_URL'), out);
    assert.ok(out.includes('process.env.API_TOKEN'), out);
    assert.ok(out.includes(`if (vvResp.status() !== 200) throw new Error(`), out);
    assert.ok(out.includes(`process.env['LOGIN_RESP'] = await vvResp.text();`), out);
  });

  it('later steps can consume saveAs via {{VAR}}', () => {
    const out = compileTest(
      defWithSteps([
        step('a1', 'apiRequest', { method: 'GET', url: 'https://example.com/api', saveAs: 'API_BODY' }),
        step('s2', 'fill', {
          target: T({ strategy: 'label', value: 'Token' }),
          value: '{{API_BODY}}',
        }),
      ]),
    );
    assert.ok(out.includes(`process.env['API_BODY'] = await vvResp.text();`), out);
    assert.ok(out.includes('process.env.API_BODY!'), out);
  });

  it('bad method / missing url / bad expectedStatus / bad saveAs fail explicitly', () => {
    assert.throws(
      () => compileTest(defWithSteps([step('a1', 'apiRequest', { method: 'FETCH', url: 'https://x' })])),
      InvalidDefinitionError,
    );
    assert.throws(
      () => compileTest(defWithSteps([step('a1', 'apiRequest', { method: 'GET' })])),
      InvalidDefinitionError,
    );
    assert.throws(
      () => compileTest(defWithSteps([step('a1', 'apiRequest', { method: 'GET', url: 'https://x', expectedStatus: 99 })])),
      InvalidDefinitionError,
    );
    assert.throws(
      () => compileTest(defWithSteps([step('a1', 'apiRequest', { method: 'GET', url: 'https://x', saveAs: 'has-dash' })])),
      InvalidDefinitionError,
    );
  });

  it('unknown step type still fails explicitly (never silently skipped)', () => {
    assert.throws(
      () => compileTest(defWithSteps([step('s9', 'dragAndDrop')])),
      (e: unknown) => e instanceof UnsupportedStepError && e.stepId === 's9',
    );
  });
});

describe('mockRoute', () => {
  it('emits page.route with fulfill + method fallthrough', () => {
    const out = compileTest(
      defWithSteps([
        step('m1', 'mockRoute', {
          url: '**/api/users',
          method: 'GET',
          status: 500,
          body: '{"error":"mocked"}',
          contentType: 'application/json',
        }),
      ]),
    );
    assert.ok(out.includes('await page.route('), out);
    assert.ok(out.includes('vvRoute.fulfill'), out);
    assert.ok(out.includes('vvRoute.fallback()'), out);
    assert.ok(out.includes('status: 500'), out);
  });

  it('method-less route fulfills everything', () => {
    const out = compileTest(
      defWithSteps([step('m1', 'mockRoute', { url: '**/api/slow' })]),
    );
    assert.ok(!out.includes('fallback'), out);
    assert.ok(out.includes('status: 200'), out);
  });

  it('missing url / bad status / bad method fail explicitly', () => {
    assert.throws(
      () => compileTest(defWithSteps([step('m1', 'mockRoute', {})])),
      InvalidDefinitionError,
    );
    assert.throws(
      () => compileTest(defWithSteps([step('m1', 'mockRoute', { url: '**/x', status: 99 })])),
      InvalidDefinitionError,
    );
    assert.throws(
      () => compileTest(defWithSteps([step('m1', 'mockRoute', { url: '**/x', method: 'FETCH' })])),
      InvalidDefinitionError,
    );
  });
});

describe('generated code parses as TypeScript', () => {
  it('wave-2 spec with all 6 types transpiles + parses', async () => {
    const ts = await import('typescript');
    const out = compileTest(
      defWithSteps([
        step('s1', 'goto', { url: 'https://example.com/login' }),
        step('u1', 'upload', { target: T({ strategy: 'label', value: 'File' }), fileId: 'f1' }),
        step('d1', 'download', { target: T({ strategy: 'role', role: 'link', name: 'Export' }), saveAs: 'r.csv' }),
        step('d2', 'download', { url: 'https://example.com/export', saveAs: 'o.csv' }),
        step('t1', 'newTab', { url: 'https://example.com/docs' }),
        step('s2', 'click', { target: T({ strategy: 'text', value: 'Save' }) }),
        step('h1', 'handleDialog', { action: 'accept', promptText: 'ok' }),
        step('s3', 'click', { target: T({ strategy: 'text', value: 'Delete' }) }),
        step('c1', 'closeTab', {}),
        step('a1', 'apiRequest', { method: 'GET', url: 'https://example.com/api', expectedStatus: 200, saveAs: 'RESP' }),
      ]),
    );
    const js = ts.transpileModule(out, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const { Script } = await import('node:vm');
    new Script(js, { filename: 'wave2.spec.js' });
  });
});

describe('P0 byte-identical guarantee', () => {  it('login-test.json golden is unchanged when no wave-2 step is present', () => {
    const root = findRepoRoot();
    const raw = fs.readFileSync(path.join(root, 'examples', 'login-test.json'), 'utf8');
    const out = compileTest(JSON.parse(raw) as TestDefinition);
    assert.ok(out.includes('async ({ page }) => {'), out);
    assert.ok(!out.includes('context'), out);
    assert.ok(!out.includes('request'), out);
    assert.ok(!out.includes('page2'), out);
  });

  it('row refs in new apiRequest body still require a dataset', () => {
    assert.throws(
      () =>
        compileTest(
          defWithSteps([step('a1', 'apiRequest', { method: 'POST', url: 'https://x', body: '{{row.NAME}}' })]),
        ),
      InvalidDefinitionError,
    );
  });
});
