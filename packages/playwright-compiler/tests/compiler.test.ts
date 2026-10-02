/**
 * P0 compiler tests (node:test + node:assert/strict).
 * Run: `npm run build && node --test dist/tests/*.test.js`
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  compileTest,
  defaultStepName,
  InvalidDefinitionError,
  SUPPORTED_STEP_TYPES,
  UnsupportedStepError,
  type TestDefinition,
  type TestStep,
} from '../src/compiler';
import {
  locatorToExpression,
  UnsupportedLocatorError,
  type LocatorSpec,
} from '../src/locatorToExpression';
import {
  compileValueExpression,
  escapeString,
  extractVariableNames,
  hasVariable,
  redactSecrets,
  stringLiteral,
} from '../src/variables';

function defWithSteps(steps: TestStep[], extra: Partial<TestDefinition> = {}): TestDefinition {
  return {
    schemaVersion: '1.0',
    id: 'test_demo',
    projectId: 'project_demo',
    name: 'Demo test',
    browser: 'chromium',
    steps,
    ...extra,
  };
}

function step(id: string, type: string, fields: Record<string, unknown> = {}): TestStep {
  return { id, type, enabled: true, ...fields };
}

/** Walk up from the compiled test dir to find the repo `examples/` folder. */
function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'examples', 'login-test.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('Could not locate repo root (examples/login-test.json not found)');
}

// ---------------------------------------------------------------------------
// Locator mapping table
// ---------------------------------------------------------------------------

describe('locatorToExpression mapping table', () => {
  const cases: Array<[LocatorSpec, string]> = [
    [
      { primary: { strategy: 'role', role: 'button', name: 'Login' } },
      `page.getByRole('button', { name: 'Login' })`,
    ],
    [
      { primary: { strategy: 'role', role: 'textbox', name: 'Email', exact: true } },
      `page.getByRole('textbox', { name: 'Email', exact: true })`,
    ],
    [{ primary: { strategy: 'label', value: 'Email' } }, `page.getByLabel('Email')`],
    [
      { primary: { strategy: 'label', value: 'Email', exact: true } },
      `page.getByLabel('Email', { exact: true })`,
    ],
    [
      { primary: { strategy: 'placeholder', value: 'Search...' } },
      `page.getByPlaceholder('Search...')`,
    ],
    [{ primary: { strategy: 'testId', value: 'submit-btn' } }, `page.getByTestId('submit-btn')`],
    [{ primary: { strategy: 'text', value: 'Dashboard' } }, `page.getByText('Dashboard')`],
    [
      { primary: { strategy: 'css', value: '#main .submit' } },
      `page.locator('#main .submit')`,
    ],
    [
      { primary: { strategy: 'xpath', value: "//button[@id='go']" } },
      `page.locator('xpath=//button[@id=\\'go\\']')`,
    ],
  ];
  for (const [spec, expected] of cases) {
    it(`${spec.primary.strategy} -> ${expected}`, () => {
      assert.equal(locatorToExpression(spec), expected);
    });
  }

  it('throws UnsupportedLocatorError on unknown strategy', () => {
    const bad = { primary: { strategy: 'id', value: 'x' } } as unknown as LocatorSpec;
    assert.throws(() => locatorToExpression(bad), UnsupportedLocatorError);
  });

  it('alternatives are ignored (primary only, P0)', () => {
    const spec: LocatorSpec = {
      primary: { strategy: 'label', value: 'Email' },
      alternatives: [{ strategy: 'css', value: '#email' }],
    };
    assert.equal(locatorToExpression(spec), `page.getByLabel('Email')`);
  });
});

// ---------------------------------------------------------------------------
// String safety + variables
// ---------------------------------------------------------------------------

describe('string escaping', () => {
  it('escapes single quotes, backslashes and control chars', () => {
    assert.equal(escapeString(`o'clock\\path`), `o\\'clock\\\\path`);
    assert.equal(stringLiteral(`a'b`), `'a\\'b'`);
    assert.equal(escapeString('l1\nl2\ttab\rr'), 'l1\\nl2\\ttab\\rr');
  });

  it('locator values with quotes compile safely', () => {
    const expr = locatorToExpression({
      primary: { strategy: 'role', role: 'button', name: `It's "go"` },
    });
    assert.equal(expr, `page.getByRole('button', { name: 'It\\'s "go"' })`);
  });
});

describe('variables ({{NAME}} -> process.env.NAME)', () => {
  it('whole-string reference compiles to required env lookup', () => {
    assert.equal(compileValueExpression('{{ADMIN_EMAIL}}'), 'process.env.ADMIN_EMAIL!');
    assert.equal(compileValueExpression('{{  BASE_URL  }}'), 'process.env.BASE_URL!');
  });

  it('mixed text compiles to a template literal', () => {
    assert.equal(
      compileValueExpression('{{BASE_URL}}/login'),
      '`' + '${process.env.BASE_URL}/login' + '`',
    );
  });

  it('plain text compiles to an escaped literal', () => {
    assert.equal(compileValueExpression('hello'), `'hello'`);
    assert.equal(compileValueExpression(`o'clock`), `'o\\'clock'`);
  });

  it('extractVariableNames / hasVariable', () => {
    assert.deepEqual(extractVariableNames('{{A}}/x/{{B}}/{{A}}'), ['A', 'B']);
    assert.equal(hasVariable('no vars'), false);
    assert.equal(hasVariable('{{YES}}'), true);
  });

  it('never inlines secrets; redactSecrets scrubs runtime logs', () => {
    const out = compileTest(
      defWithSteps([
        step('s1', 'fill', {
          target: { primary: { strategy: 'label', value: 'Password' } },
          value: '{{ADMIN_PASSWORD}}',
          sensitive: true,
        }),
      ]),
    );
    assert.match(out, /process\.env\.ADMIN_PASSWORD!/);
    const env = { ADMIN_PASSWORD: 's3cr3t-pw' };
    const log = `filled with s3cr3t-pw via process.env.ADMIN_PASSWORD`;
    assert.equal(redactSecrets(log, ['ADMIN_PASSWORD'], env), 'filled with *** via process.env.***');
  });
});

// ---------------------------------------------------------------------------
// Step compilation (full P0 catalog)
// ---------------------------------------------------------------------------

describe('compileStepBody — full P0 step catalog', () => {
  const T = (target: LocatorSpec['primary']) => ({ primary: target });

  const cases: Array<[TestStep, string[]]> = [
    [step('s1', 'goto', { url: '{{BASE_URL}}/login' }), ['await page.goto(`${process.env.BASE_URL}/login`);']],
    [step('s1', 'reload'), ['await page.reload();']],
    [step('s1', 'goBack'), ['await page.goBack();']],
    [step('s1', 'goForward'), ['await page.goForward();']],
    [
      step('s1', 'click', { target: T({ strategy: 'role', role: 'button', name: 'Login' }) }),
      [`await page.getByRole('button', { name: 'Login' }).click();`],
    ],
    [
      step('s1', 'doubleClick', { target: T({ strategy: 'text', value: 'Item' }) }),
      [`await page.getByText('Item').dblclick();`],
    ],
    [
      step('s1', 'fill', { target: T({ strategy: 'label', value: 'Email' }), value: 'a@b.c' }),
      [`await page.getByLabel('Email').fill('a@b.c');`],
    ],
    [
      step('s1', 'clear', { target: T({ strategy: 'label', value: 'Email' }) }),
      [`await page.getByLabel('Email').clear();`],
    ],
    [
      step('s1', 'press', { target: T({ strategy: 'css', value: '#q' }), key: 'Enter' }),
      [`await page.locator('#q').press('Enter');`],
    ],
    [step('s1', 'press', { key: 'Escape' }), [`await page.keyboard.press('Escape');`]],
    [
      step('s1', 'check', { target: T({ strategy: 'label', value: 'Remember' }) }),
      [`await page.getByLabel('Remember').check();`],
    ],
    [
      step('s1', 'uncheck', { target: T({ strategy: 'label', value: 'Remember' }) }),
      [`await page.getByLabel('Remember').uncheck();`],
    ],
    [
      step('s1', 'select', { target: T({ strategy: 'label', value: 'Country' }), value: 'VN' }),
      [`await page.getByLabel('Country').selectOption('VN');`],
    ],
    [
      step('s1', 'hover', { target: T({ strategy: 'role', role: 'menuitem', name: 'File' }) }),
      [`await page.getByRole('menuitem', { name: 'File' }).hover();`],
    ],
    [
      step('s1', 'waitForElement', { target: T({ strategy: 'text', value: 'Loaded' }), state: 'visible' }),
      [`await page.getByText('Loaded').waitFor({ state: 'visible' });`],
    ],
    [
      step('s1', 'waitForTimeout', { milliseconds: 500 }),
      [
        '// WARNING: fixed wait is discouraged; prefer waitForElement/waitForURL.',
        'await page.waitForTimeout(500);',
      ],
    ],
    [
      step('s1', 'waitForURL', { url: '{{BASE_URL}}/dashboard' }),
      ['await page.waitForURL(`${process.env.BASE_URL}/dashboard`);'],
    ],
    [
      step('s1', 'assertVisible', { target: T({ strategy: 'text', value: 'Dashboard' }) }),
      [`await expect(page.getByText('Dashboard')).toBeVisible();`],
    ],
    [
      step('s1', 'assertHidden', { target: T({ strategy: 'text', value: 'Spinner' }) }),
      [`await expect(page.getByText('Spinner')).toBeHidden();`],
    ],
    [
      step('s1', 'assertText', { target: T({ strategy: 'text', value: 'Hi' }), expected: 'Hello' }),
      [`await expect(page.getByText('Hi')).toHaveText('Hello');`],
    ],
    [
      step('s1', 'assertContainsText', { target: T({ strategy: 'css', value: '.msg' }), expected: 'ok' }),
      [`await expect(page.locator('.msg')).toContainText('ok');`],
    ],
    [
      step('s1', 'assertValue', { target: T({ strategy: 'label', value: 'Email' }), expected: 'a@b.c' }),
      [`await expect(page.getByLabel('Email')).toHaveValue('a@b.c');`],
    ],
    [step('s1', 'assertURL', { expected: '{{BASE_URL}}/home' }), ['await expect(page).toHaveURL(`${process.env.BASE_URL}/home`);']],
    [step('s1', 'assertTitle', { expected: 'Home' }), [`await expect(page).toHaveTitle('Home');`]],
    [
      step('s1', 'assertEnabled', { target: T({ strategy: 'testId', value: 'go' }) }),
      [`await expect(page.getByTestId('go')).toBeEnabled();`],
    ],
    [
      step('s1', 'assertDisabled', { target: T({ strategy: 'testId', value: 'go' }) }),
      [`await expect(page.getByTestId('go')).toBeDisabled();`],
    ],
    [
      step('s1', 'assertChecked', { target: T({ strategy: 'label', value: 'Agree' }) }),
      [`await expect(page.getByLabel('Agree')).toBeChecked();`],
    ],
    [
      step('s1', 'screenshot', { name: 'final', fullPage: true }),
      [`await page.screenshot({ path: 'screenshots/final.png', fullPage: true });`],
    ],
  ];

  for (const [s, expected] of cases) {
    it(`${s.type} compiles`, () => {
      const out = compileTest(defWithSteps([s]));
      for (const line of expected) assert.ok(out.includes(line), `missing: ${line}\n${out}`);
      assert.ok(out.includes('await test.step('), 'must preserve test.step() wrapper');
    });
  }

  it('covers every SUPPORTED_STEP_TYPES entry', () => {
    const types = new Set(cases.map(([s]) => s.type));
    for (const t of SUPPORTED_STEP_TYPES) {
      assert.ok(types.has(t), `no coverage for step type "${t}"`);
    }
  });

  it('unsupported step fails explicitly (never silently skipped)', () => {
    assert.throws(
      () => compileTest(defWithSteps([step('s9', 'dragAndDrop')])),
      (e: unknown) =>
        e instanceof UnsupportedStepError &&
        e.stepId === 's9' &&
        /dragAndDrop/.test((e as Error).message),
    );
  });

  it('disabled steps are skipped with a comment, enabled steps kept', () => {
    const out = compileTest(
      defWithSteps([
        { ...step('s1', 'reload'), enabled: false },
        step('s2', 'reload'),
      ]),
    );
    assert.ok(out.includes('// skipped disabled step s1 (reload)'));
    assert.ok(out.includes('await page.reload();'));
  });

  it('step name override wins; otherwise deterministic default name', () => {
    const named = compileTest(
      defWithSteps([step('s1', 'reload', { name: 'Custom title' })]),
    );
    assert.ok(named.includes(`await test.step('Custom title'`));
    assert.equal(defaultStepName(step('s1', 'reload')), 'Reload page');
  });

  it('timeoutMs becomes a test.step option; continueOnFailure wraps in try/catch', () => {
    const out = compileTest(
      defWithSteps([step('s1', 'reload', { timeoutMs: 3000, continueOnFailure: true })]),
    );
    assert.ok(out.includes('}, { timeout: 3000 });'));
    assert.ok(out.includes('try {'));
    assert.ok(out.includes('// continueOnFailure: step s1 failed, continuing.'));
  });

  it('rejects bad schemaVersion and missing fields explicitly', () => {
    const badVersion = defWithSteps([step('s1', 'reload')]) as unknown as Record<string, unknown>;
    badVersion['schemaVersion'] = '2.0';
    assert.throws(() => compileTest(badVersion as unknown as TestDefinition), InvalidDefinitionError);
    assert.throws(
      () => compileTest(defWithSteps([step('s1', 'click')])),
      InvalidDefinitionError,
    );
  });

  it('escapes hostile test/step names', () => {
    const out = compileTest(
      defWithSteps([step('s1', 'reload', { name: `a'b\\c` })], { name: `t'e\`st` }),
    );
    assert.ok(out.includes(`test('t\\'e\`st'`));
    assert.ok(out.includes(`await test.step('a\\'b\\\\c'`));
  });
});

// ---------------------------------------------------------------------------
// Determinism + golden test
// ---------------------------------------------------------------------------

const GOLDEN_LINES: string[] = [
  `// Generated by @vietvang/playwright-compiler v0.1.0 - do not edit.`,
  `// Test: test_login_success | schema: 1.0`,
  `import { test, expect } from '@playwright/test';`,
  ``,
  `test('Login successfully', async ({ page }) => {`,
  `  await test.step('Navigate to {{BASE_URL}}/login', async () => {`,
  '    await page.goto(`${process.env.BASE_URL}/login`);',
  `  });`,
  ``,
  `  await test.step('Fill Email', async () => {`,
  `    await page.getByLabel('Email').fill(process.env.ADMIN_EMAIL!);`,
  `  });`,
  ``,
  `  await test.step('Fill Password', async () => {`,
  `    await page.getByLabel('Password').fill(process.env.ADMIN_PASSWORD!);`,
  `  });`,
  ``,
  `  await test.step('Click Login button', async () => {`,
  `    await page.getByRole('button', { name: 'Login' }).click();`,
  `  });`,
  ``,
  `  await test.step('Verify Dashboard', async () => {`,
  `    await expect(page.getByText('Dashboard')).toBeVisible();`,
  `  });`,
  `});`,
  ``,
];

describe('determinism + golden', () => {
  it('same input + version -> byte-identical output', () => {
    const root = findRepoRoot();
    const raw = fs.readFileSync(path.join(root, 'examples', 'login-test.json'), 'utf8');
    const a = compileTest(JSON.parse(raw) as TestDefinition);
    const b = compileTest(JSON.parse(raw) as TestDefinition);
    assert.equal(a, b);
  });

  it('golden: examples/login-test.json compiles to the checked-in snapshot', () => {
    const root = findRepoRoot();
    const raw = fs.readFileSync(path.join(root, 'examples', 'login-test.json'), 'utf8');
    const out = compileTest(JSON.parse(raw) as TestDefinition);
    assert.equal(out, GOLDEN_LINES.join('\n'));
  });
});
