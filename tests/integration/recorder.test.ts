/**
 * Integration: recorder capture -> normalize -> definition (+ session recovery).
 * Strategy: 12-testing/test-strategy.md (Integration: Recorder capture→definition;
 * Release gate: recorder normalization/debounce, interrupted recovery).
 * Pure in-process test (no DB, no browser).
 *
 * Run: npx tsx --test tests/integration/recorder.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { captureBridgeEvent } from '../../packages/recorder/src/capture.js';
import { normalizeBatch, StepNormalizer } from '../../packages/recorder/src/normalize.js';
import { RecorderSessionManager } from '../../packages/recorder/src/sessionManager.js';
import { emitStepCaptured, emitSession } from '../../packages/recorder/src/emitter.js';
import type { BridgeEvent, CapturedStep } from '../../packages/recorder/src/types.js';

const URL = 'http://127.0.0.1:3123/fixture/login';

function bridge(over: Partial<BridgeEvent> & { kind: BridgeEvent['kind'] }): Record<string, unknown> {
  return { url: URL, t: Date.now(), ...over } as Record<string, unknown>;
}

describe('capture allowlist + masking (capture.ts)', () => {
  it('captures navigation as goto', () => {
    const s = captureBridgeEvent(bridge({ kind: 'navigation', t: 1000 }));
    assert.equal(s?.type, 'goto');
    assert.equal(s?.url, URL);
  });

  it('ignores noise: mousemove/focus/blur/scroll/pointermove', () => {
    for (const kind of ['mousemove', 'focus', 'blur', 'scroll', 'pointermove']) {
      const s = captureBridgeEvent(
        bridge({ kind: kind as BridgeEvent['kind'], t: 1000, tag: 'DIV' }),
      );
      assert.equal(s, null, `${kind} must not be captured`);
    }
  });

  it('plain character keydown is covered by fill (not press)', () => {
    const s = captureBridgeEvent(bridge({ kind: 'keydown', t: 1000, key: 'a', tag: 'INPUT' }));
    assert.equal(s, null);
  });

  it('meaningful keys become press steps', () => {
    const s = captureBridgeEvent(
      bridge({ kind: 'keydown', t: 1000, key: 'Enter', tag: 'INPUT', inputType: 'text' }),
    );
    assert.equal(s?.type, 'press');
    assert.equal(s?.key, 'Enter');
  });

  it('masks password input at capture time', () => {
    const s = captureBridgeEvent(
      bridge({ kind: 'input', t: 1000, tag: 'INPUT', inputType: 'password', value: 's3cr3t' }),
    );
    assert.equal(s?.type, 'fill');
    assert.equal(s?.value, '***MASKED***');
    assert.equal(s?.sensitive, true);
  });

  it('checkbox clicks normalize to check/uncheck', () => {
    const on = captureBridgeEvent(
      bridge({ kind: 'click', t: 1000, tag: 'INPUT', inputType: 'checkbox', checked: true }),
    );
    const off = captureBridgeEvent(
      bridge({ kind: 'click', t: 1001, tag: 'INPUT', inputType: 'checkbox', checked: false }),
    );
    assert.equal(on?.type, 'check');
    assert.equal(off?.type, 'uncheck');
  });

  it('hover is opt-in only', () => {
    const evt = bridge({ kind: 'hover', t: 1000, tag: 'BUTTON' });
    assert.equal(captureBridgeEvent(evt, { includeHover: false }), null);
    assert.equal(captureBridgeEvent(evt, { includeHover: true })?.type, 'hover');
  });

  it('drops events without kind/url/timestamp', () => {
    assert.equal(captureBridgeEvent({ kind: 'click' }), null);
  });
});

describe('normalize: fill debounce (acceptance: merged fill, not per-key noise)', () => {
  const EMAIL_KEY = 'INPUT|text|Email|10:20|http://127.0.0.1:3123/fixture/login';

  function fill(value: string, at: number, key = EMAIL_KEY): CapturedStep {
    return { id: `f-${at}`, type: 'fill', url: URL, at, elementKey: key, value };
  }

  it('continuous typing on the same input collapses to ONE fill with the final value', () => {
    const norm = new StepNormalizer({ fillDebounceMs: 1200 });
    const emitted: CapturedStep[] = [];
    // Simulate per-keystroke bridge inputs 200ms apart.
    const keystrokes = ['t', 'te', 'tes', 'test', 'teste', 'tester'];
    keystrokes.forEach((v, i) => emitted.push(...norm.push(fill(v, 1000 + i * 200))));
    emitted.push(...norm.flush());
    const fills = emitted.filter((s) => s.type === 'fill' && s.elementKey === EMAIL_KEY);
    assert.equal(fills.length, 1, `expected 1 merged fill, got ${fills.length}`);
    assert.equal(fills[0].value, 'tester');
  });

  it('typing pauses longer than the debounce window stay separate fills', () => {
    const out = normalizeBatch([fill('first', 1000), fill('second', 1000 + 5000)], {
      fillDebounceMs: 1200,
    });
    assert.equal(out.filter((s) => s.type === 'fill').length, 2);
  });

  it('click on an input followed by fill on the same target drops the click', () => {
    const click: CapturedStep = {
      id: 'c1', type: 'click', url: URL, at: 1000, elementKey: EMAIL_KEY,
    };
    const out = normalizeBatch([click, fill('tester@example.com', 1100)]);
    assert.ok(!out.some((s) => s.id === 'c1'), 'redundant click must be removed');
    assert.equal(out.filter((s) => s.type === 'fill').length, 1);
  });

  it('redirect chains collapse to the last goto with evidence count', () => {
    const g = (url: string, at: number): CapturedStep => ({
      id: `g-${at}`, type: 'goto', url, at, elementKey: `nav|${url}`, value: url,
    });
    const out = normalizeBatch([g('http://x/a', 1000), g('http://x/b', 1200), g('http://x/c', 1400)], {
      redirectWindowMs: 1500,
    });
    const gotos = out.filter((s) => s.type === 'goto');
    assert.equal(gotos.length, 1);
    assert.equal(gotos[0].url, 'http://x/c');
    assert.equal(gotos[0].meta?.['redirectChain'], 3);
  });

  it('second masking pass scrubs sensitive fills that slipped through', () => {
    const leaked: CapturedStep = {
      id: 'f1', type: 'fill', url: URL, at: 1000, elementKey: EMAIL_KEY,
      value: 'plaintext-pw', sensitive: true,
    };
    const out = normalizeBatch([leaked]);
    assert.equal(out[0].value, '***MASKED***');
  });
});

describe('capture -> definition (login fixture flow)', () => {
  /** Mirrors apps/server toDefinitionStep: captured -> TestDefinition step. */
  function toDefinitionStep(s: CapturedStep): Record<string, unknown> {
    return {
      id: s.id, type: s.type, enabled: true,
      target: s.locator ?? null, value: s.value, key: s.key, url: s.url,
    };
  }

  it('raw bridge events become a clean login definition', () => {
    const t0 = 1_000_000;
    const raw: BridgeEvent[] = [
      { kind: 'navigation', url: URL, t: t0 },
      // per-keystroke typing on Email (same footprint -> same elementKey)
      ...['t', 'te', 'tes', 'tester@example.com'].map((value, i) => ({
        kind: 'input' as const, url: URL, t: t0 + 100 + i * 150,
        tag: 'INPUT', inputType: 'text', nameHint: 'Email',
        point: { x: 40, y: 80 }, value,
      })),
      // typing on Password (sensitive)
      ...['s3', 's3cr3t'].map((value, i) => ({
        kind: 'input' as const, url: URL, t: t0 + 900 + i * 150,
        tag: 'INPUT', inputType: 'password', nameHint: 'Password',
        point: { x: 40, y: 140 }, value,
      })),
      {
        kind: 'click', url: URL, t: t0 + 1500,
        tag: 'BUTTON', nameHint: 'Login', point: { x: 60, y: 200 },
      },
      { kind: 'keydown', url: URL, t: t0 + 1600, tag: 'BODY', key: 'F5' },
      // noise that must never survive
      { kind: 'mousemove', url: URL, t: t0 + 1650, tag: 'BODY' } as BridgeEvent,
    ];

    const captured = raw
      .map((e) => captureBridgeEvent(e as unknown as Record<string, unknown>))
      .filter((s): s is CapturedStep => s !== null);
    assert.ok(!captured.some((s) => s.type === ('mousemove' as never)));
    const normalized = normalizeBatch(captured);
    const fills = normalized.filter((s) => s.type === 'fill');
    assert.equal(fills.length, 2, 'email + password must each be exactly one fill');
    assert.equal(fills[0].value, 'tester@example.com');
    assert.equal(fills[1].value, '***MASKED***');

    const definition = normalized.map(toDefinitionStep);
    assert.ok(definition[0].type === 'goto');
    assert.ok(definition.every((s) => s['enabled'] === true));
    assert.ok(definition.every((s) => typeof s['id'] === 'string' && typeof s['type'] === 'string'));
  });
});

describe('session manager: pause/resume/interruption recovery', () => {
  const P = { userId: 'u1', testId: 't1', projectId: 'p1' };

  it('enforces one active session per user+test', () => {
    const mgr = new RecorderSessionManager();
    mgr.start(P);
    assert.throws(() => mgr.start(P), /RECORDER_ALREADY_ACTIVE/);
  });

  it('pauses buffer events; resume replays them in order', () => {
    const mgr = new RecorderSessionManager();
    const { sessionId } = mgr.start(P);
    mgr.pause(sessionId);
    const evt = bridge({ kind: 'navigation', t: 2000 });
    assert.equal(mgr.ingest(sessionId, evt), null, 'paused sessions buffer, not ingest');
    const resumed = mgr.resume(sessionId);
    assert.equal(resumed.bufferedWhilePaused.length, 0, 'buffer must drain on resume');
    const stopped = mgr.stop(sessionId);
    assert.ok(
      stopped.draftSteps.some((s) => s.type === 'goto'),
      'buffered navigation must survive pause -> resume -> stop',
    );
  });

  it('browser death marks interrupted and preserves drafts (recoverable)', () => {
    const mgr = new RecorderSessionManager();
    const { sessionId } = mgr.start(P);
    mgr.ingest(sessionId, bridge({ kind: 'navigation', t: 3000 }));
    const dead = mgr.markInterrupted(sessionId, 'browser-closed');
    assert.equal(dead.status, 'interrupted');
    assert.equal(dead.interruptReason, 'browser-closed');
    assert.ok(dead.draftSteps.length >= 1, 'draft steps must survive interruption');
    assert.equal(mgr.getBySessionId(sessionId)?.status, 'interrupted');
  });

  it('assertions emit stepCaptured; WS payloads never leak secrets', () => {
    const seen: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const send = (event: string, payload: Record<string, unknown>) => seen.push({ event, payload });
    const mgr = new RecorderSessionManager({
      onEvent: ({ type, session, step }) => {
        if (type === 'recorder.stepCaptured' && step) emitStepCaptured(send as never, session, step);
        else emitSession(send as never, type as never, session);
      },
    });
    const { sessionId } = mgr.start(P);
    const step = mgr.addAssertion(sessionId, {
      type: 'assertVisible', url: URL, elementKey: 'assert|x',
      value: 's3cr3t-pw', sensitive: true,
    } as never);
    assert.equal(step.type, 'assertVisible');
    const emitted = seen.find((e) => e.event === 'recorder.stepCaptured')!;
    assert.ok(emitted, 'stepCaptured must be emitted');
    const wireStep = (emitted.payload as { step: CapturedStep }).step;
    assert.equal(wireStep.value, '***MASKED***');
  });
});
