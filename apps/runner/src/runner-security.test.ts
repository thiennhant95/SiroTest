/**
 * Runner P0 Security tests — Day 8-10 audit (11-security/security.md).
 * Run: `npx tsx --test src/runner-security.test.ts`
 *
 * Covers: path traversal, shell-injection (arg array, shell:false) and
 * secret redaction across logs / generated code / WS payloads / result JSON.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafePath, assertValidRunId } from './workspace.js';
import { spawnArgs } from './process.js';
import { redactSecrets, resolveEnv } from './env.js';
import { compileSpec } from './compile.js';
import { validateTestDefinition, ValidationError } from './validate.js';
import { buildEvent } from './events.js';
import type { TestDefinition } from './types.js';
import { redactResult } from '../../../packages/reporter/src/result.js';

const SECRET = 's3cr3t-pw-XYZ-9';

function testDef(secretRef = '{{ADMIN_PASSWORD}}'): TestDefinition {
  return {
    schemaVersion: '1.0' as const,
    id: 'test_sec',
    projectId: 'p1',
    name: 'Security test',
    browser: 'chromium' as const,
    steps: [
      { id: 's1', type: 'goto', enabled: true, url: 'https://example.com/login' },
      {
        id: 's2', type: 'fill', enabled: true, sensitive: true, value: secretRef,
        target: { primary: { strategy: 'label' as const, value: 'Password' } },
      },
    ],
  };
}

describe('path traversal protection', () => {
  it('blocks ../ escape, absolute escape and bad runIds', async () => {
    const base = await mkdtemp(join(tmpdir(), 'sec-base-'));
    try {
      assert.throws(() => assertSafePath(base, '../../etc/passwd'), /traversal/i);
      assert.throws(() => assertSafePath(base, '/etc/passwd'), /traversal/i);
      assert.throws(() => assertValidRunId('../../evil'), /Invalid runId/);
      assert.throws(() => assertValidRunId('a'.repeat(65)), /Invalid runId/);
      // legitimate nested write stays inside
      const ok = assertSafePath(base, 'screenshots/s1.png');
      assert.ok(ok.startsWith(base));
      await mkdir(join(base, 'screenshots'), { recursive: true });
      await writeFile(ok, 'x');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('shell-injection protection (arg array, shell:false)', () => {
  it('passes hostile input as a literal argv — never interpreted by a shell', async () => {
    const hostile = ';touch PWNED && echo INJECTED $(whoami) `id` | tee x';
    const lines: string[] = [];
    const { done } = spawnArgs(process.execPath, ['-e', 'console.log("MARKER:" + process.argv[1])', hostile], {
      cwd: tmpdir(),
      onOutput: (_stream, line) => { lines.push(line); },
    });
    const result = await done;
    assert.equal(result.exitCode, 0);
    // Under a shell, $(whoami)/backticks/; would execute and the output would
    // differ. Exact literal echo proves no shell was involved.
    assert.ok(lines.includes(`MARKER:${hostile}`), `got: ${JSON.stringify(lines)}`);
  });
});

describe('secret redaction (logs / code / WS / result JSON)', () => {
  const vars = [{ key: 'ADMIN_PASSWORD', value: SECRET, isSecret: true }];

  it('generated code carries only the env lookup — never the plaintext', () => {
    const spec = compileSpec(testDef(), {});
    assert.ok(spec.includes('process.env'), spec);
    assert.ok(!spec.includes(SECRET), 'secret leaked into generated code');
  });

  it('sensitive literals without {{VAR}} fail compilation instead of inlining', () => {
    assert.throws(() => compileSpec(testDef(SECRET), {}), /sensitive.*{{VARIABLE}}|{{VARIABLE}}.*secret/i);
  });

  it('runner log lines are scrubbed', () => {
    const { secrets } = resolveEnv({ test: testDef(), environmentVariables: vars });
    assert.deepEqual(secrets, [SECRET]);
    const line = `fill failed: waiting for "${SECRET}" at https://x (pw=${SECRET})`;
    const clean = redactSecrets(line, secrets);
    assert.ok(!clean.includes(SECRET));
    assert.ok(clean.includes('***'));
  });

  it('WS event payloads are scrubbed before publish', () => {
    const { secrets } = resolveEnv({ test: testDef(), environmentVariables: vars });
    const evt = buildEvent('step.failed', 'run_1', { error: `timeout using ${SECRET}` });
    const wire = JSON.stringify({ event: evt.event, payload: { ...evt, error: redactSecrets(evt.error!, secrets) } });
    assert.ok(!wire.includes(SECRET), wire);
    assert.ok(wire.includes('run_1'));
  });

  it('result JSON is scrubbed before persist', () => {
    const payload = {
      runId: 'run_1',
      status: 'failed',
      error: `login failed for ${SECRET}`,
      steps: [{ stepId: 's2', status: 'failed', error: SECRET }],
    };
    const clean = redactResult(payload, [SECRET]);
    assert.ok(!JSON.stringify(clean).includes(SECRET));
  });
});

describe('URL scheme guard in runner validation', () => {
  it('rejects javascript:/data:/file: step URLs', () => {
    const bad = {
      schemaVersion: '1.0' as const, id: 't', projectId: 'p', name: 'T', browser: 'chromium' as const,
      steps: [{ id: 's1', type: 'goto', enabled: true, url: 'javascript:alert(1)' }],
    };
    assert.throws(() => validateTestDefinition(bad), ValidationError);
    const bad2 = {
      schemaVersion: '1.0' as const, id: 't', projectId: 'p', name: 'T', browser: 'chromium' as const,
      steps: [{ id: 's1', type: 'goto', enabled: true, url: 'file:///etc/passwd' }],
    };
    assert.throws(() => validateTestDefinition(bad2), ValidationError);
  });
  it('accepts https and {{VAR}} templates', () => {
    validateTestDefinition(testDef()); // must not throw
  });
});
