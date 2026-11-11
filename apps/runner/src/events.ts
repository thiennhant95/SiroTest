/**
 * Step 6/8 â€” Run/step event streaming over WebSocket.
 * Event names follow spec/08-api/websocket-events.md. Events are informational;
 * the database state remains authoritative. Every payload carries runId.
 */

import type { RunStatus, StepStatus } from './types.js';

export type RunEventName =
  | 'run.queued'
  | 'run.started'
  | 'step.started'
  | 'step.passed'
  | 'step.failed'
  | 'step.skipped'
  | 'run.passed'
  | 'run.failed'
  | 'run.cancelled'
  | 'step.healed';

export interface RunEvent {
  event: RunEventName;
  runId: string;
  at: number;
  stepId?: string;
  status?: RunStatus | StepStatus;
  durationMs?: number;
  error?: string;
  /**
   * P2 â€” healing evidence for `step.healed` (see healing.ts HealEvidence).
   * The name is a first-class union member; like all WS events it is
   * informational only (DB authoritative). Proposal persistence travels in
   * the `runTest()` return value for the server to store as reviewable
   * `HealingProposal` rows â€” never silently applied.
   */
  evidence?: unknown;
}

/** Transport-agnostic publisher; the server wires this to its WS gateway. */
export type EventPublisher = (event: RunEvent) => void;

export function noopPublisher(): EventPublisher {
  return () => undefined;
}

/** Fan-out to several publishers; one failing sink never breaks the run. */
export function fanout(publishers: EventPublisher[]): EventPublisher {
  return (event) => {
    for (const p of publishers) {
      try {
        p(event);
      } catch {
        // ignore sink errors â€” events are informational
      }
    }
  };
}

export function buildEvent(
  event: RunEventName,
  runId: string,
  extra?: Pick<RunEvent, 'stepId' | 'status' | 'durationMs' | 'error' | 'evidence'>,
): RunEvent {
  return { event, runId, at: Date.now(), ...extra };
}
