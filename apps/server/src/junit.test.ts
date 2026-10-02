/**
 * Unit: JUnit XML builder (P1 CLI/CI trigger + JUnit export).
 * Run: npx tsx --test apps/server/src/junit.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildJunitXml } from './junit.js';

describe('buildJunitXml', () => {
  it('emits testsuite/testcase with failure bodies and valid counts', () => {
    const xml = buildJunitXml('suite-login', [
      { name: 'login ok', classname: 'suite-login', status: 'passed', durationMs: 1200 },
      {
        name: 'login bad', classname: 'suite-login', status: 'failed',
        durationMs: 300, message: 'assert failed', body: 'expected Dashboard',
      },
    ]);
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<testsuites tests="2" failures="1" skipped="0">/);
    assert.match(xml, /<testsuite name="suite-login" tests="2" failures="1" skipped="0"/);
    assert.match(xml, /<testcase classname="suite-login" name="login ok" time="1\.200">/);
    assert.match(
      xml,
      /<failure message="assert failed">expected Dashboard<\/failure>/,
    );
  });

  it('escapes XML metacharacters in names and messages', () => {
    const xml = buildJunitXml('a&b <suite>', [
      {
        name: 't"1\'<x>', classname: 'c&c', status: 'failed',
        message: 'a < b && "c"', body: "it's <bad> & broken",
      },
    ]);
    assert.ok(!xml.includes('a&b'), 'raw & must be escaped');
    assert.match(xml, /name="a&amp;b &lt;suite&gt;"/);
    assert.match(xml, /name="t&quot;1&apos;&lt;x&gt;"/);
    assert.match(xml, /message="a &lt; b &amp;&amp; &quot;c&quot;"/);
    assert.match(xml, />it&apos;s &lt;bad&gt; &amp; broken<\/failure>/);
  });

  it('redacts secret values everywhere (names, messages, bodies)', () => {
    const secret = 's3cr3t-junit-pw';
    const xml = buildJunitXml('suite', [
      {
        name: `login ${secret}`, classname: 'suite', status: 'failed',
        message: `pw=${secret} end`, body: `leaked ${secret} here`,
      },
    ], { secrets: [secret] });
    assert.ok(!xml.includes(secret), 'secret plaintext must never appear in XML');
    assert.match(xml, /\*\*\*/);
  });

  it('marks non-terminal/cancelled runs as skipped, never passed', () => {
    const xml = buildJunitXml('suite', [
      { name: 'a', classname: 's', status: 'cancelled' },
      { name: 'b', classname: 's', status: 'running' },
    ]);
    assert.match(xml, /<testsuites tests="2" failures="0" skipped="2">/);
    assert.equal((xml.match(/<skipped /g) ?? []).length, 2);
    assert.ok(!xml.includes('<failure'), 'no silent passes, no failures either');
  });

  it('labels retry attempts so CI can tell tries apart', () => {
    const xml = buildJunitXml('suite', [
      { name: 'flaky', classname: 's', status: 'failed', attempt: 2 },
    ]);
    assert.match(xml, /name="flaky \[attempt 2\]"/);
  });
});
