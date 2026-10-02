/**
 * Compiler P0 Security tests — Day 8-10 audit (11-security/security.md).
 * Run: `npm run build && node --test dist/tests/security.test.js`
 *
 * The compiler never sees secret VALUES (only {{NAME}} refs), so the contract
 * is: no caller-supplied secret string may survive into emitted code, and
 * runtime logs/surfaces that echo values must be scrubbable.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileTest, InvalidDefinitionError, type TestDefinition, type TestStep } from '../src/compiler';
import { compileValueExpression, redactSecrets } from '../src/variables';

const SECRET = 's3cr3t-pw-XYZ-9';

function step(id: string, type: string, fields: Record<string, unknown> = {}): TestStep {
  return { id, type, enabled: true, ...fields };
}

function defWithSteps(steps: TestStep[]): TestDefinition {
  return {
    schemaVersion: '1.0', id: 'test_sec', projectId: 'p1',
    name: 'Security test', browser: 'chromium', steps,
  };
}

describe('secrets never appear in generated code', () => {
  it('{{VAR}} refs compile to process.env lookups (value unknown at compile time)', () => {
    const out = compileTest(defWithSteps([
      step('s1', 'fill', {
        target: { primary: { strategy: 'label', value: 'Password' } },
        value: '{{ADMIN_PASSWORD}}',
        sensitive: true,
      }),
    ]));
    assert.match(out, /process\.env\.ADMIN_PASSWORD/);
    assert.ok(!out.includes(SECRET));
  });

  it('sensitive literal without {{VAR}} fails loudly instead of inlining', () => {
    assert.throws(
      () =>
        compileTest(defWithSteps([
          step('s1', 'fill', {
            target: { primary: { strategy: 'label', value: 'Password' } },
            value: SECRET,
            sensitive: true,
          }),
        ])),
      InvalidDefinitionError,
    );
  });

  it('compileValueExpression never reads process.env at compile time', () => {
    process.env.INJECTED_SECRET = SECRET;
    try {
      const out = compileValueExpression('prefix-{{INJECTED_SECRET}}-suffix');
      assert.ok(out.includes('process.env.INJECTED_SECRET'));
      assert.ok(!out.includes(SECRET), out);
    } finally {
      delete process.env.INJECTED_SECRET;
    }
  });
});

describe('redaction of logs / WS / result surfaces', () => {
  const env = { ADMIN_PASSWORD: SECRET };

  it('runtime log lines scrub values and lookup shapes', () => {
    const log = `filled with ${SECRET} via process.env.ADMIN_PASSWORD (step s1)`;
    assert.equal(
      redactSecrets(log, ['ADMIN_PASSWORD'], env as NodeJS.ProcessEnv),
      'filled with *** via process.env.*** (step s1)',
    );
  });

  it('a simulated WS frame carries no plaintext after redaction', () => {
    const frame = JSON.stringify({ event: 'step.failed', payload: { runId: 'r1', error: `bad ${SECRET}` } });
    const clean = redactSecrets(frame, ['ADMIN_PASSWORD'], env as NodeJS.ProcessEnv);
    assert.ok(!clean.includes(SECRET));
    assert.ok(clean.includes('r1'));
  });

  it('a simulated result.json carries no plaintext after redaction', () => {
    const resultJson = JSON.stringify({
      runId: 'r1', status: 'failed', error: SECRET,
      steps: [{ stepId: 's1', error: `expected ${SECRET}` }],
    });
    const clean = redactSecrets(resultJson, ['ADMIN_PASSWORD'], env as NodeJS.ProcessEnv);
    assert.ok(!clean.includes(SECRET));
  });
});
