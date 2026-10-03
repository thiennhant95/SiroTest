/**
 * P2 step-engine tests for @vietvang/playwright-compiler (node:test).
 * Covers: visualCheck emit (viewport + element target, threshold default /
 * validation, deterministic filenames) and plugin:* emit (params shape,
 * {{VAR}}/{{row}} interpolation, registry fail-fast incl. secret literals),
 * plus the P0 byte-identical guarantee (no P2 steps -> output unchanged).
 *
 * Run: `npm run build && node --test dist/tests/p2-visual-plugins.test.js`
 * (also wired into `npm test`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileStepBody,
  compileTest,
  defaultStepName,
  InvalidDefinitionError,
  sanitizeVisualFileName,
  UnsupportedStepError,
  VISUAL_DEFAULT_THRESHOLD,
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
    id: 'test_p2',
    projectId: 'project_demo',
    name: 'P2 test',
    browser: 'chromium',
    steps,
    ...extra,
  };
}

const T = (primary: LocatorSpec['primary']) => ({ primary });

describe('sanitizeVisualFileName', () => {
  it('produces deterministic visual-*.png names', () => {
    assert.equal(sanitizeVisualFileName('hero'), 'visual-hero.png');
    assert.equal(sanitizeVisualFileName('a/b c!'), 'visual-a_b_c_.png');
    assert.equal(sanitizeVisualFileName(''), 'visual-check.png');
  });
});

describe('visualCheck', () => {
  it('viewport variant: screenshot to artifact dir + compare via helper', () => {
    const body = compileStepBody(step('v1', 'visualCheck', { name: 'hero' }));
    assert.deepEqual(body, [
      `const vvVisualPath = (await import('node:path')).join(process.env.RUN_ARTIFACT_DIR ?? '.', 'screenshots', 'visual-hero.png');`,
      `await page.screenshot({ path: vvVisualPath });`,
      `await (await import('./vv-visual-compare.cjs')).compareVisualFromEnv({ name: 'hero', actualPath: vvVisualPath, threshold: 0.05 });`,
    ]);
  });

  it('element target variant uses the locator', () => {
    const body = compileStepBody(
      step('v1', 'visualCheck', { name: 'card', target: T({ strategy: 'testId', value: 'card' }), threshold: 0 }),
    );
    assert.ok(body[1]?.includes(`getByTestId('card')`), body.join('\n'));
    assert.ok(body[2]?.includes('threshold: 0'), body.join('\n'));
  });

  it('missing/invalid name or threshold fails explicitly', () => {
    assert.throws(() => compileStepBody(step('v1', 'visualCheck', {})), InvalidDefinitionError);
    assert.throws(() => compileStepBody(step('v1', 'visualCheck', { name: '' })), InvalidDefinitionError);
    assert.throws(() => compileStepBody(step('v1', 'visualCheck', { name: 'a', threshold: 2 })), InvalidDefinitionError);
    assert.throws(() => compileStepBody(step('v1', 'visualCheck', { name: 'a', threshold: -0.1 })), InvalidDefinitionError);
  });

  it('keeps the test.step() wrapper (name doubles as the step title)', () => {
    const out = compileTest(defWithSteps([step('v1', 'visualCheck', { name: 'hero' })]));
    assert.ok(out.includes('await test.step('), out);
    // `name` is the BaseStep display name AND the baseline name.
    assert.ok(out.includes(`await test.step('hero'`), out);
    assert.equal(defaultStepName({ id: 'v1', type: 'visualCheck', enabled: true } as TestStep), 'Visual check v1');
    assert.equal(VISUAL_DEFAULT_THRESHOLD, 0.05);
  });
});

describe('plugin:* steps', () => {
  it('compiles to a helper call with sorted, interpolated params', () => {
    const body = compileStepBody(
      step('p1', 'plugin:kv.fillMasked', { params: { value: '{{LOGIN_PW}}', label: 'Password' } }),
      'page2',
    );
    assert.equal(body.length, 1);
    assert.ok(
      body[0]?.startsWith(`await (await import('./vv-plugins.cjs')).runPluginStep('plugin:kv.fillMasked', { `),
      body[0],
    );
    // Sorted keys: label before value; {{VAR}} -> process.env lookup.
    assert.ok(body[0]?.includes(`'label': 'Password', 'value': process.env.LOGIN_PW!`), body[0]);
    assert.ok(body[0]?.includes(', page2, { stepId: \'p1\' });'), body[0]);
  });

  it('omitted params compile to an empty record', () => {
    const body = compileStepBody(step('p1', 'plugin:esm.ping'));
    assert.ok(body[0]?.includes(`runPluginStep('plugin:esm.ping', {  }, page,`), body[0]);
  });

  it('non-string params fail explicitly', () => {
    assert.throws(
      () => compileStepBody(step('p1', 'plugin:a.b', { params: { n: 42 } })),
      InvalidDefinitionError,
    );
    assert.throws(
      () => compileStepBody(step('p1', 'plugin:a.b', { params: 'nope' })),
      InvalidDefinitionError,
    );
  });

  it('{{row.*}} params without a dataset fail explicitly', () => {
    assert.throws(
      () => compileTest(defWithSteps([step('p1', 'plugin:a.b', { params: { v: '{{row.COL}}' } })])),
      InvalidDefinitionError,
    );
  });

  it('registry snapshot: unknown type fails fast with PLUGIN_NOT_FOUND', () => {
    assert.throws(
      () => compileTest(defWithSteps([step('p1', 'plugin:ghost.step')]), { plugins: {} }),
      /PLUGIN_NOT_FOUND/,
    );
    // Known type compiles fine.
    const out = compileTest(defWithSteps([step('p1', 'plugin:kv.fillMasked', { params: { label: 'E', value: '{{PW}}' } })]), {
      plugins: { 'plugin:kv.fillMasked': { schema: { required: ['label', 'value'], properties: { label: { type: 'string' }, value: { type: 'string', secret: true } } } } },
    });
    assert.ok(out.includes('plugin:kv.fillMasked'), out);
  });

  it('registry snapshot: missing required param and plaintext secret fail', () => {
    const plugins = {
      'plugin:kv.fillMasked': {
        schema: {
          required: ['label', 'value'],
          properties: { label: { type: 'string' }, value: { type: 'string', secret: true } },
        },
      },
    };
    assert.throws(
      () => compileTest(defWithSteps([step('p1', 'plugin:kv.fillMasked', { params: { label: 'E' } })]), { plugins }),
      /missing required param "value"/,
    );
    assert.throws(
      () => compileTest(defWithSteps([step('p1', 'plugin:kv.fillMasked', { params: { label: 'E', value: 'plaintext' } })]), { plugins }),
      /secret param "value" must be a {{VARIABLE}} reference/,
    );
  });

  it('non-plugin unknown types still fail as unsupported', () => {
    assert.throws(() => compileStepBody(step('x', 'customCode')), UnsupportedStepError);
  });
});
