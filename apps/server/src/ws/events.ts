/** Run + recorder WS payload builders (08-api/websocket-events.md). */
export type WsSend = (event: string, payload: Record<string, unknown>) => void;

export function runEvent(
  send: WsSend,
  type:
    | 'run.queued' | 'run.started' | 'step.started' | 'step.passed'
    | 'step.failed' | 'step.skipped' | 'run.passed' | 'run.failed' | 'run.cancelled'
    | 'step.healed',
  runId: string,
  extra: Record<string, unknown> = {},
): void {
  send(type, { runId, at: Date.now(), ...extra });
}
