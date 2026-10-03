/**
 * Capture filtering: only real http(s) navigations become goto steps.
 * Browser-internal targets (about:blank, chrome-error://, ...) are failure
 * artifacts or initial state — capturing them makes recording flaky
 * (their arrival races listener setup / error-page timing).
 *
 * Run: pnpm --filter @vv/recorder test   (node --test tests/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { captureBridgeEvent } from '../dist/capture.js';

const nav = (url) => ({ kind: 'navigation', url, t: Date.now() });

describe('navigation filtering (deterministic recording)', () => {
  it('keeps real http(s) navigations', () => {
    const s = captureBridgeEvent(nav('https://example.com/login'));
    assert.ok(s, 'https goto captured');
    assert.equal(s.type, 'goto');
    const local = captureBridgeEvent(nav('http://127.0.0.1:3123/fixture/login'));
    assert.ok(local, 'loopback http goto captured');
  });

  it('drops about:blank (racy initial state, never test intent)', () => {
    assert.equal(captureBridgeEvent(nav('about:blank')), null);
  });

  it('drops browser-internal and error schemes', () => {
    for (const url of [
      'chrome-error://chromewebdata/',
      'chrome://newtab/',
      'edge://settings/',
      'data:text/html,hi',
      'javascript:void(0)',
      'file:///etc/passwd',
    ]) {
      assert.equal(captureBridgeEvent(nav(url)), null, url);
    }
  });

  it('drops malformed URLs instead of crashing', () => {
    assert.equal(captureBridgeEvent(nav('not a url at all')), null);
    assert.equal(captureBridgeEvent({ kind: 'navigation', t: Date.now() }), null);
  });
});
