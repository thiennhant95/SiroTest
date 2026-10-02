/** WS event builders — payloads always carry sessionId (websocket-events.md). */
import type { CapturedStep, RecorderSession } from './types.js';

export type WsSend = (event: string, payload: Record<string, unknown>) => void;

export function emitStepCaptured(send: WsSend, session: RecorderSession, step: CapturedStep): void {
  send('recorder.stepCaptured', {
    sessionId: session.sessionId,
    testId: session.testId,
    step: sanitize(step),
    draftCount: session.draftSteps.length,
    at: Date.now(),
  });
}

export function emitSession(
  send: WsSend,
  type:
    | 'recorder.started' | 'recorder.paused' | 'recorder.resumed'
    | 'recorder.stopped' | 'recorder.interrupted' | 'recorder.locatorPicked',
  session: RecorderSession,
  extra: Record<string, unknown> = {},
): void {
  send(type, {
    sessionId: session.sessionId,
    testId: session.testId,
    status: session.status,
    draftCount: session.draftSteps.length,
    interruptReason: session.interruptReason,
    at: Date.now(),
    ...extra,
  });
}

function sanitize(step: CapturedStep): CapturedStep {
  // belt & suspenders: never leak unmasked secrets over WS
  if (step.sensitive && step.value !== '***MASKED***') return { ...step, value: '***MASKED***' };
  return step;
}
