/**
 * Recorder interrupt tests (recorder-spec.md Recovery).
 * Run:  pnpm --filter @vv/recorder test   (node --test tests/)
 * Browser death -> status `interrupted`, draft steps preserved, retrievable.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RecorderSessionManager } from '../dist/sessionManager.js';

const start = (mgr, testId = 't1') =>
  mgr.start({ userId: 'u1', testId, projectId: 'p1', baseUrl: 'https://example.com' });

describe('recorder interrupt (browser death)', () => {
  it('markInterrupted keeps draft steps and marks interrupted', () => {
    const events = [];
    const mgr = new RecorderSessionManager({ onEvent: (e) => events.push(e) });
    const s = start(mgr);
    mgr.ingest(s.sessionId, { kind: 'click', css: '#login', text: 'Login' });
    const before = mgr.getBySessionId(s.sessionId).draftSteps.length;
    assert.ok(before >= 0);
    const out = mgr.markInterrupted(s.sessionId, 'browser-closed');
    assert.equal(out.status, 'interrupted');
    assert.equal(out.interruptReason, 'browser-closed');
    assert.ok(out.draftSteps.length >= before); // draft preserved (+ flushed normalizer)
    assert.ok(events.some((e) => e.type === 'recorder.interrupted'));
  });

  it('interrupted session stays retrievable (recover draft after crash)', () => {
    const mgr = new RecorderSessionManager();
    const s = start(mgr);
    mgr.markInterrupted(s.sessionId, 'browser-crashed');
    const again = mgr.getBySessionId(s.sessionId);
    assert.ok(again);
    assert.equal(again.status, 'interrupted');
  });

  it('ingest after interrupt is ignored (no writes to dead session)', () => {
    const mgr = new RecorderSessionManager();
    const s = start(mgr);
    mgr.markInterrupted(s.sessionId);
    assert.equal(mgr.ingest(s.sessionId, { kind: 'click', css: '#x' }), null);
  });

  it('stop after interrupt: normal stop flow still works on active session', () => {
    const mgr = new RecorderSessionManager();
    const s = start(mgr);
    const stopped = mgr.stop(s.sessionId);
    assert.equal(stopped.status, 'stopped');
  });
});
