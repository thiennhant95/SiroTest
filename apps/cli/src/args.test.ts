/**
 * Unit: CLI manual arg parsing (no commander) + env fallbacks.
 * Run: npx tsx --test apps/cli/src/args.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UsageError, parseArgs } from './args.js';

const ENV = { STUDIO_API_URL: 'http://localhost:3001', STUDIO_TOKEN: 'tok-123' };

describe('parseArgs', () => {
  it('parses run with defaults', () => {
    const cmd = parseArgs(['run', '--test', 't1', '--env', 'e1'], ENV);
    assert.equal(cmd.name, 'run');
    if (cmd.name !== 'run') throw new Error('narrow');
    assert.equal(cmd.api, 'http://localhost:3001');
    assert.equal(cmd.token, 'tok-123');
    assert.equal(cmd.browser, 'chromium');
    assert.equal(cmd.headed, false);
    assert.equal(cmd.wait, false);
    assert.equal(cmd.timeoutMs, 600_000);
    assert.equal(cmd.intervalMs, 2000);
  });
  it('parses run flags, --key=value form and env overrides', () => {
    const cmd = parseArgs(
      ['run', '--api', 'http://x:1/', '--token', 'T', '--test', 't', '--env', 'e',
        '--browser=firefox', '--headed', '--dataset', 'd', '--row', '2',
        '--wait', '--timeout-ms', '5000', '--interval-ms=250'],
      {},
    );
    assert.equal(cmd.name, 'run');
    if (cmd.name !== 'run') throw new Error('narrow');
    assert.equal(cmd.api, 'http://x:1');
    assert.equal(cmd.browser, 'firefox');
    assert.equal(cmd.headed, true);
    assert.equal(cmd.datasetId, 'd');
    assert.equal(cmd.rowIndex, 2);
    assert.equal(cmd.wait, true);
    assert.equal(cmd.timeoutMs, 5000);
    assert.equal(cmd.intervalMs, 250);
  });
  it('parses suite-run with retries/parallel', () => {
    const cmd = parseArgs(
      ['suite-run', '--suite', 's', '--env', 'e', '--retries', '2', '--parallel', '1', '--wait'],
      ENV,
    );
    assert.equal(cmd.name, 'suite-run');
    if (cmd.name !== 'suite-run') throw new Error('narrow');
    assert.equal(cmd.retries, 2);
    assert.equal(cmd.parallel, 1);
    assert.equal(cmd.wait, true);
  });
  it('parses export targets with format defaults', () => {
    const a = parseArgs(['export', '--test', 't', '-o', 'a.spec.ts'], ENV);
    assert.equal(a.name, 'export');
    if (a.name !== 'export') throw new Error('narrow');
    assert.deepEqual(a.target, { kind: 'test', testId: 't' });
    assert.equal(a.format, 'spec');
    const b = parseArgs(['export', '--run', 'r', '-o', 'j.xml'], ENV);
    if (b.name !== 'export') throw new Error('narrow');
    assert.equal(b.format, 'junit');
    const c = parseArgs(['export', '--suite-run', 'sr', '--format', 'junit', '--out', 'j.xml'], ENV);
    if (c.name !== 'export') throw new Error('narrow');
    assert.deepEqual(c.target, { kind: 'suite-run', suiteRunId: 'sr' });
  });
  it('parses trigger-schedules --once', () => {
    const cmd = parseArgs(['trigger-schedules', '--once'], { DATABASE_URL: 'file:x.db' });
    assert.deepEqual(cmd, { name: 'trigger-schedules', once: true, databaseUrl: 'file:x.db' });
  });
  it('handles help forms', () => {
    assert.deepEqual(parseArgs([], ENV), { name: 'help' });
    assert.deepEqual(parseArgs(['--help'], ENV), { name: 'help' });
    assert.deepEqual(parseArgs(['run', '--help'], ENV), { name: 'help', topic: 'run' });
    assert.deepEqual(parseArgs(['help', 'export'], ENV), { name: 'help', topic: 'export' });
  });
  it('rejects missing/invalid input with UsageError', () => {
    const cases: string[][] = [
      ['run', '--test', 't'],
      ['run', '--env', 'e'],
      ['run', '--test', 't', '--env', 'e', '--browser', 'safari'],
      ['run', '--test', 't', '--env', 'e', '--row', '1'],
      ['run', '--test', 't', '--env', 'e', '--bogus', 'x'],
      ['run', '--test', 't', '--env', 'e', '--timeout-ms', '-5'],
      ['suite-run', '--suite', 's', '--env', 'e', '--parallel', '3'],
      ['suite-run', '--suite', 's', '--env', 'e', '--retries', '9'],
      ['export', '--test', 't', '--run', 'r', '-o', 'x'],
      ['export', '--test', 't', '--format', 'junit', '-o', 'x'],
      ['export', '--run', 'r', '--format', 'spec', '-o', 'x'],
      ['export', '--run', 'r'],
      ['trigger-schedules'],
      ['frobnicate'],
    ];
    for (const argv of cases) {
      assert.throws(() => parseArgs(argv, ENV), UsageError, argv.join(' '));
    }
    // Missing token/api (empty env).
    assert.throws(() => parseArgs(['run', '--test', 't', '--env', 'e'], {}), UsageError);
    assert.throws(() => parseArgs(['run', '--api', 'notaurl', '--token', 'T', '--test', 't', '--env', 'e'], {}), UsageError);
  });
});
