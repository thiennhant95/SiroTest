/**
 * sessionManager.ts — P0: ONE active session per user+test.
 * Controls: Start / Pause / Resume / Stop / Pick-Assertion.
 * Recovery: browser death -> status `interrupted`, draft steps preserved.
 */
import { nanoid } from 'nanoid';
import { captureBridgeEvent } from './capture.js';
import { StepNormalizer } from './normalize.js';
import type { BridgeEvent, CapturedStep, RecorderSession } from './types.js';

export interface SessionEvents {
  onEvent?: (evt: { type: string; session: RecorderSession; step?: CapturedStep }) => void;
}

export interface StartParams {
  userId: string;
  testId: string;
  projectId: string;
  includeHover?: boolean;
  baseUrl?: string;
}

export class RecorderSessionManager {
  /** key `${userId}:${testId}` -> session (P0 single-session rule) */
  private sessions = new Map<string, RecorderSession>();
  private normalizers = new Map<string, StepNormalizer>();
  private events: SessionEvents;

  constructor(events: SessionEvents = {}) {
    this.events = events;
  }

  private key(userId: string, testId: string): string {
    return `${userId}:${testId}`;
  }

  get(testId: string, userId: string): RecorderSession | undefined {
    return this.sessions.get(this.key(userId, testId));
  }

  getBySessionId(sessionId: string): RecorderSession | undefined {
    for (const s of this.sessions.values()) if (s.sessionId === sessionId) return s;
    return undefined;
  }

  start(p: StartParams): RecorderSession {
    const k = this.key(p.userId, p.testId);
    const existing = this.sessions.get(k);
    if (existing && (existing.status === 'active' || existing.status === 'paused')) {
      const err = new Error('RECORDER_ALREADY_ACTIVE') as Error & { code?: string };
      err.code = 'CONFLICT_RECORDER_ACTIVE';
      throw err;
    }
    const now = Date.now();
    const session: RecorderSession = {
      sessionId: `rec_${nanoid(12)}`,
      testId: p.testId,
      userId: p.userId,
      projectId: p.projectId,
      status: 'active',
      startedAt: now,
      updatedAt: now,
      draftSteps: [],
      bufferedWhilePaused: [],
      pickMode: 'off',
      includeHover: p.includeHover ?? false,
    };
    this.sessions.set(k, session);
    this.normalizers.set(session.sessionId, new StepNormalizer());
    this.events.onEvent?.({ type: 'recorder.started', session });
    return session;
  }

  pause(sessionId: string): RecorderSession {
    const s = this.require(sessionId);
    if (s.status !== 'active') this.fail('RECORDER_NOT_ACTIVE', 'Only active sessions can pause');
    s.status = 'paused';
    s.updatedAt = Date.now();
    this.events.onEvent?.({ type: 'recorder.paused', session: s });
    return s;
  }

  resume(sessionId: string): RecorderSession {
    const s = this.require(sessionId);
    if (s.status !== 'paused') this.fail('INVALID_STATE', 'Only paused sessions can resume');
    s.status = 'active';
    s.updatedAt = Date.now();
    // replay buffered events in order
    const buffered = s.bufferedWhilePaused.splice(0);
    for (const b of buffered) this.ingest(sessionId, b);
    this.events.onEvent?.({ type: 'recorder.resumed', session: s });
    return s;
  }

  stop(sessionId: string): RecorderSession {
    const s = this.require(sessionId);
    if (s.status === 'stopped') return s;
    const norm = this.normalizers.get(sessionId);
    if (norm) s.draftSteps.push(...norm.flush());
    s.status = 'stopped';
    s.updatedAt = Date.now();
    this.events.onEvent?.({ type: 'recorder.stopped', session: s });
    this.sessions.delete(this.key(s.userId, s.testId));
    this.normalizers.delete(sessionId);
    return s;
  }

  /** Browser closed/crashed: keep draft, mark interrupted (stays retrievable). */
  markInterrupted(sessionId: string, reason = 'browser-closed'): RecorderSession {
    const s = this.require(sessionId);
    const norm = this.normalizers.get(sessionId);
    if (norm) s.draftSteps.push(...norm.flush());
    s.status = 'interrupted';
    s.interruptReason = reason;
    s.updatedAt = Date.now();
    this.events.onEvent?.({ type: 'recorder.interrupted', session: s });
    return s;
  }

  aliasBrowserDeath = this.markInterrupted.bind(this);

  setPickMode(sessionId: string, mode: 'off' | 'locator' | 'assertion'): RecorderSession {
    const s = this.require(sessionId);
    s.pickMode = mode;
    s.updatedAt = Date.now();
    if (mode !== 'off') this.events.onEvent?.({ type: 'recorder.locatorPicked', session: s });
    return s;
  }

  addAssertion(sessionId: string, step: Omit<CapturedStep, 'id' | 'at' | 'elementKey'> & { elementKey?: string }): CapturedStep {
    const s = this.require(sessionId);
    if (s.status !== 'active') this.fail('RECORDER_NOT_ACTIVE', 'Cannot add assertion unless active');
    const full: CapturedStep = {
      id: nanoid(10), at: Date.now(),
      elementKey: step.elementKey ?? `assert|${step.type}|${Date.now()}`,
      ...step,
    } as CapturedStep;
    const norm = this.normalizers.get(sessionId) ?? new StepNormalizer();
    this.normalizers.set(sessionId, norm);
    const finalized = norm.push(full);
    s.draftSteps.push(...finalized);
    s.updatedAt = Date.now();
    this.events.onEvent?.({ type: 'recorder.stepCaptured', session: s, step: full });
    return full;
  }

  /** Main ingest path from WS bridge messages. */
  ingest(sessionId: string, raw: unknown): CapturedStep | null {
    const s = this.require(sessionId);
    if (s.status === 'stopped' || s.status === 'interrupted') return null;
    if (s.status === 'paused') {
      s.bufferedWhilePaused.push(raw as BridgeEvent);
      return null;
    }
    const captured = captureBridgeEvent((raw ?? {}) as Record<string, unknown>, {
      includeHover: s.includeHover,
    });
    if (!captured) return null;
    const norm = this.normalizers.get(sessionId) ?? new StepNormalizer();
    this.normalizers.set(sessionId, norm);
    const finalized = norm.push(captured);
    s.draftSteps.push(...finalized);
    s.updatedAt = Date.now();
    this.events.onEvent?.({ type: 'recorder.stepCaptured', session: s, step: captured });
    return captured;
  }

  private require(sessionId: string): RecorderSession {
    const s = this.getBySessionId(sessionId);
    if (!s) this.fail('NOT_FOUND', `Recorder session ${sessionId} not found`);
    return s as RecorderSession;
  }

  private fail(code: string, message: string): never {
    const err = new Error(message) as Error & { code?: string };
    err.code = code;
    throw err;
  }
}
