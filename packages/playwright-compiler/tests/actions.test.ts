/**
 * P1 reusable-actions tests for @vietvang/playwright-compiler (node:test).
 * Covers: callAction inlining (+ defaults), missing-arg / unknown-action /
 * nested-callAction explicit failures, secret-param redaction rules, and
 * the P0 byte-identical guarantee (no actions -> compile as before).
 *
 * Run: `npm run build && node --test dist/tests/actions.test.js`
 * (also wired into `npm test`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  compileTest,
  InvalidDefinitionError,
  UnsupportedStepError,
  type ReusableAction,
  type TestDefinition,
  type TestStep,
} from '../src/compiler';

function step(id: string, type: string, fields: Record<string, unknown> = {}): TestStep {
  return { id, type, enabled: true, ...fields };
}

function defWithSteps(steps: TestStep[], extra: Partial<TestDefinition> = {}): TestDefinition {
  return {
    schemaVersion: '1.0',
    id: 'test_actions',
    projectId: 'project_demo',
    name: 'Actions test',
    browser: 'chromium',
    steps,
    ...extra,
  };
}

const LOGIN_ACTION: ReusableAction = {
  schemaVersion: '1.0',
  id: 'act_login',
  projectId: 'project_demo',
  name: 'Login',
  parameters: [
    { name: 'EMAIL' },
    { name: 'PASSWORD', secret: true },
    { name: 'SUBMIT', default: 'Login' },
  ],
  steps: [
    step('b1', 'fill', {
      target: { primary: { strategy: 'label', value: 'Email' } },
      value: '{{EMAIL}}',
    }),
    step('b2', 'fill', {
      target: { primary: { strategy: 'label', value: 'Password' } },
      value: '{{PASSWORD}}',
      sensitive: true,
    }),
    step('b3', 'click', {
      target: { primary: { strategy: 'role', role: 'button', name: '{{SUBMIT}}' } },
    }),
  ],
};

function loginCall(extra: Record<string, unknown> = {}): TestStep {
  return step('c1', 'callAction', {
    actionId: 'act_login',
    arguments: { EMAIL: 'tester@example.com', PASSWORD: '{{ADMIN_PASSWORD}}' },
    ...extra,
  });
}

const ACTIONS = new Map([['act_login', LOGIN_ACTION]]);

/** Walk up from the compiled test dir to find the repo `examples/` folder. */
function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'examples', 'login-test.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('Could not locate repo root (examples/login-test.json not found)');
}

describe('callAction inlining', () => {
  it('inlines the interpolated body inside test.step(action name)', () => {
    const out = compileTest(defWithSteps([loginCall()]), { actions: ACTIONS });
    assert.ok(out.includes(`await test.step('Call Login'`), `outer wrapper:\n${out}`);
    assert.ok(out.includes(`await page.getByLabel('Email').fill('tester@example.com');`), `arg interpolated:\n${out}`);
    // Secret param resolves to a runtime env lookup, never the value.
    assert.ok(out.includes('process.env.ADMIN_PASSWORD!'), `secret lookup:\n${out}`);
    // Param default applies when the caller omits the argument.
    assert.ok(out.includes(`getByRole('button', { name: 'Login' })`), `default applied:\n${out}`);
    // Non-param {{VAR}} placeholders would pass through untouched (none here).
    assert.ok(!out.includes('{{'), `no uninterpolated params remain:\n${out}`);
  });

  it('caller step name wins over the action name', () => {
    const out = compileTest(defWithSteps([loginCall({ name: 'Sign in as admin' })]), {
      actions: ACTIONS,
    });
    assert.ok(out.includes(`await test.step('Sign in as admin'`), out);
  });

  it('accepts a plain record lookup as well as a Map', () => {
    const a = compileTest(defWithSteps([loginCall()]), { actions: ACTIONS });
    const b = compileTest(defWithSteps([loginCall()]), {
      actions: { act_login: LOGIN_ACTION },
    });
    assert.equal(a, b);
  });

  it('same definition + actions -> byte-identical output', () => {
    const def = defWithSteps([loginCall(), step('s9', 'reload')]);
    assert.equal(
      compileTest(def, { actions: ACTIONS }),
      compileTest(JSON.parse(JSON.stringify(def)), { actions: ACTIONS }),
    );
  });

  it('generated code parses as TypeScript', async () => {
    const ts = await import('typescript');
    const out = compileTest(defWithSteps([loginCall(), step('s9', 'reload')]), {
      actions: ACTIONS,
    });
    const js = ts.transpileModule(out, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const { Script } = await import('node:vm');
    new Script(js, { filename: 'actions.spec.js' });
  });

  it('keeps body-step timeoutMs/continueOnFailure; honours caller-level ones', () => {
    const action: ReusableAction = {
      ...LOGIN_ACTION,
      id: 'act_t',
      steps: [
        { ...LOGIN_ACTION.steps[2]!, timeoutMs: 7000, continueOnFailure: true },
      ],
    };
    const out = compileTest(
      defWithSteps([loginCall({ timeoutMs: 9000, continueOnFailure: true })]),
      { actions: new Map([['act_login', action]]) },
    );
    assert.ok(out.includes('}, { timeout: 7000 });'), `child timeout:\n${out}`);
    assert.ok(out.includes('// continueOnFailure: step b3 failed, continuing.'), `child cof:\n${out}`);
    assert.ok(out.includes('}, { timeout: 9000 });'), `caller timeout:\n${out}`);
    assert.ok(out.includes('// continueOnFailure: step c1 failed, continuing.'), `caller cof:\n${out}`);
  });

  it('marks disabled body steps with a comment instead of running them', () => {
    const action: ReusableAction = {
      ...LOGIN_ACTION,
      id: 'act_d',
      steps: [{ ...LOGIN_ACTION.steps[0]!, enabled: false }, LOGIN_ACTION.steps[1]!],
    };
    const out = compileTest(defWithSteps([loginCall()]), {
      actions: new Map([['act_login', action]]) ,
    });
    assert.ok(out.includes('// skipped disabled step b1 (fill)'), out);
    assert.ok(!out.includes(`fill('tester@example.com')`), `disabled body not emitted:\n${out}`);
  });

  it('leaves non-param {{VARIABLE}} placeholders as runtime env lookups', () => {
    const action: ReusableAction = {
      schemaVersion: '1.0',
      id: 'act_v',
      projectId: 'project_demo',
      name: 'GotoEnv',
      parameters: [{ name: 'PATH' }],
      steps: [step('b1', 'goto', { url: '{{BASE_URL}}{{PATH}}' })],
    };
    const out = compileTest(
      defWithSteps([
        step('c1', 'callAction', {
          actionId: 'act_v',
          arguments: { PATH: '/login' },
        }),
      ]),
      { actions: new Map([['act_v', action]]) },
    );
    assert.ok(out.includes('process.env.BASE_URL'), `env passthrough:\n${out}`);
    assert.ok(out.includes('/login'), `param interpolated:\n${out}`);
  });
});

describe('callAction explicit failures (never silent)', () => {
  it('unknown actionId fails with an explicit UnsupportedStepError', () => {
    assert.throws(
      () => compileTest(defWithSteps([loginCall()]), { actions: new Map() }),
      (e: unknown) =>
        e instanceof UnsupportedStepError &&
        e.stepId === 'c1' &&
        /unknown action "act_login"/.test((e as Error).message),
    );
  });

  it('callAction without an actions context fails explicitly', () => {
    assert.throws(
      () => compileTest(defWithSteps([loginCall()])),
      (e: unknown) => e instanceof UnsupportedStepError && /actions/.test((e as Error).message),
    );
  });

  it('missing required argument (no default) fails explicitly', () => {
    const bad = loginCall({
      arguments: { PASSWORD: '{{ADMIN_PASSWORD}}' },
    });
    assert.throws(
      () => compileTest(defWithSteps([bad]), { actions: ACTIONS }),
      (e: unknown) =>
        e instanceof UnsupportedStepError && /missing required argument "EMAIL"/.test((e as Error).message),
    );
  });

  it('unknown argument name fails explicitly', () => {
    const bad = loginCall({
      arguments: {
        EMAIL: 'a@b.c',
        PASSWORD: '{{ADMIN_PASSWORD}}',
        NOPE: 'x',
      },
    });
    assert.throws(
      () => compileTest(defWithSteps([bad]), { actions: ACTIONS }),
      (e: unknown) =>
        e instanceof UnsupportedStepError && /unknown argument "NOPE"/.test((e as Error).message),
    );
  });

  it('nested callAction in an action body is rejected explicitly', () => {
    const nested: ReusableAction = {
      schemaVersion: '1.0',
      id: 'act_outer',
      projectId: 'project_demo',
      name: 'Outer',
      parameters: [],
      steps: [step('n1', 'callAction', { actionId: 'act_login' })],
    };
    assert.throws(
      () =>
        compileTest(
          defWithSteps([step('c1', 'callAction', { actionId: 'act_outer' })]),
          { actions: new Map([['act_outer', nested]]) },
        ),
      (e: unknown) =>
        e instanceof UnsupportedStepError && /nested callAction/.test((e as Error).message),
    );
  });

  it('secret param passed as a plaintext literal fails (never inlined)', () => {
    const bad = loginCall({
      arguments: { EMAIL: 'a@b.c', PASSWORD: 'plaintext-pw' },
    });
    assert.throws(
      () => compileTest(defWithSteps([bad]), { actions: ACTIONS }),
      (e: unknown) =>
        e instanceof InvalidDefinitionError &&
        /secret parameter "PASSWORD".*\{\{VARIABLE\}\}/.test((e as Error).message),
    );
  });

  it('plaintext default for a secret param fails (never inlined)', () => {
    const action: ReusableAction = {
      schemaVersion: '1.0',
      id: 'act_s',
      projectId: 'project_demo',
      name: 'S',
      parameters: [{ name: 'TOKEN', secret: true, default: 'hardcoded' }],
      steps: [step('b1', 'goto', { url: 'https://example.com/?t={{TOKEN}}' })],
    };
    assert.throws(
      () =>
        compileTest(defWithSteps([step('c1', 'callAction', { actionId: 'act_s' })]), {
          actions: new Map([['act_s', action]]),
        }),
      (e: unknown) => e instanceof InvalidDefinitionError && /plaintext default/.test((e as Error).message),
    );
  });

  it('sensitive body fill stays enforced after interpolation', () => {
    // EMAIL is not secret, but the body marks the fill sensitive: after
    // interpolation the value is a literal, so the P0 sensitive rule fires.
    const action: ReusableAction = {
      schemaVersion: '1.0',
      id: 'act_sens',
      projectId: 'project_demo',
      name: 'Sens',
      parameters: [{ name: 'EMAIL' }],
      steps: [
        step('b1', 'fill', {
          target: { primary: { strategy: 'label', value: 'Email' } },
          value: '{{EMAIL}}',
          sensitive: true,
        }),
      ],
    };
    assert.throws(
      () =>
        compileTest(
          defWithSteps([
            step('c1', 'callAction', { actionId: 'act_sens', arguments: { EMAIL: 'a@b.c' } }),
          ]),
          { actions: new Map([['act_sens', action]]) },
        ),
      InvalidDefinitionError,
    );
  });
});

describe('P0 byte-identical guarantee', () => {
  it('no actions -> P0 output unchanged (golden login example)', () => {
    const root = findRepoRoot();
    const raw = fs.readFileSync(path.join(root, 'examples', 'login-test.json'), 'utf8');
    const a = compileTest(JSON.parse(raw) as TestDefinition);
    const b = compileTest(JSON.parse(raw) as TestDefinition, { actions: new Map() });
    const c = compileTest(JSON.parse(raw) as TestDefinition, {});
    assert.equal(a, b);
    assert.equal(a, c);
    assert.ok(a.includes(`page.getByLabel('Email').fill(process.env.ADMIN_EMAIL!);`));
  });
});
