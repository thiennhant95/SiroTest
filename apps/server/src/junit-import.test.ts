/**
 * Unit: JUnit XML import parser (migration aid → draft shells).
 * Run: npx tsx --test apps/server/src/junit-import.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JunitParseError, parseJunitXml } from './junit-import.js';

const DOC = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="3" failures="1" skipped="1">
  <testsuite name="login" tests="3" failures="1" skipped="1" time="2.5">
    <testcase classname="login" name="valid login passes" time="1.2" />
    <testcase classname="login" name="wrong password fails" time="0.8">
      <failure message="expected Dashboard">Error: expect(locator).toBeVisible() failed</failure>
    </testcase>
    <testcase classname="login" name="sso login">
      <skipped message="no sso in lab" />
    </testcase>
  </testsuite>
</testsuites>`;

describe('parseJunitXml', () => {
  it('maps cases to passed/failed/skipped with messages', () => {
    const doc = parseJunitXml(DOC);
    assert.equal(doc.suiteName, 'login');
    assert.equal(doc.cases.length, 3);
    assert.deepEqual(doc.cases[0], {
      name: 'login :: valid login passes', classname: 'login', caseName: 'valid login passes',
      status: 'passed', timeSeconds: 1.2, message: null,
    });
    assert.equal(doc.cases[1].status, 'failed');
    assert.equal(doc.cases[1].message, 'expected Dashboard');
    assert.equal(doc.cases[2].status, 'skipped');
    assert.equal(doc.cases[2].message, 'no sso in lab');
  });

  it('decodes entities + CDATA and tolerates missing attrs', () => {
    const doc = parseJunitXml(
      '<testsuite><testcase name="a &amp; b"><failure><![CDATA[x < y & z]]></failure></testcase>' +
      '<testcase name="bare" /></testsuite>',
    );
    assert.equal(doc.suiteName, null);
    assert.equal(doc.cases[0].caseName, 'a & b');
    assert.equal(doc.cases[0].message, 'x < y & z');
    assert.equal(doc.cases[1].status, 'passed');
  });

  it('treats <error> as failed and drops nameless cases', () => {
    const doc = parseJunitXml(
      '<testsuite><testcase classname="c" name="boom"><error message="crash" /></testcase>' +
      '<testcase classname="c" /></testsuite>',
    );
    assert.equal(doc.cases.length, 1);
    assert.equal(doc.cases[0].status, 'failed');
  });

  it('rejects non-JUnit text and case-less documents explicitly', () => {
    assert.throws(() => parseJunitXml('<html><body>hi</body></html>'), JunitParseError);
    assert.throws(() => parseJunitXml('<testsuite name="empty"></testsuite>'), JunitParseError);
    assert.throws(() => parseJunitXml(''), JunitParseError);
  });

  it('round-trips our own export (export → import)', async () => {
    const { buildJunitXml } = await import('./junit.js');
    const xml = buildJunitXml('suite-login', [
      { name: 'login ok', classname: 'suite-login', status: 'passed', durationMs: 1200 },
      { name: 'login bad', classname: 'suite-login', status: 'failed', durationMs: 300, message: 'assert failed', body: 'expected Dashboard' },
    ]);
    const doc = parseJunitXml(xml);
    assert.equal(doc.cases.length, 2);
    assert.equal(doc.cases[0].status, 'passed');
    assert.equal(doc.cases[1].status, 'failed');
    assert.match(doc.cases[1].message ?? '', /assert failed/);
  });
});
