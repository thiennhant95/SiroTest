import { useEffect, useRef, useState } from 'react';
import { api, type Run } from '../lib/api';

/**
 * WS client for run events (08-api/websocket-events.md).
 * - Subscribes to run.queued/started/step.started/passed/failed/skipped/healed
 *   and run.passed/failed/cancelled.
 * - Every payload MUST carry runId; frames without it are ignored.
 * - Events are informational only: on (re)connect we refetch GET /runs/:id (DB authoritative).
 */

export type RunEventType =
  | 'run.queued' | 'run.started' | 'step.started' | 'step.passed'
  | 'step.failed' | 'step.skipped' | 'step.healed'
  | 'run.passed' | 'run.failed' | 'run.cancelled';

export interface WsRunEvent {
  event: RunEventType;
  payload: { runId: string; stepId?: string; sortOrder?: number; error?: string; at?: number };
}

const TERMINAL = new Set(['passed', 'failed', 'cancelled']);

function wsUrl(): string {
  // Same-origin first (vite proxy in dev, same host in prod); explicit
  // VITE_API_BASE only for split deployments.
  const base = import.meta.env.VITE_API_BASE as string | undefined;
  if (base) {
    const origin = base.replace(/\/api\/v1\/?$/, '');
    return `${origin.replace(/^http/, 'ws')}/ws`;
  }
  try {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/ws`;
  } catch {
    return 'ws://localhost:3001/ws';
  }
}

/** Same credential as REST (localStorage vv_token or dev fallback) for ?token=. */
function wsToken(): string {
  try {
    const t = localStorage.getItem('vv_token');
    if (t) return t;
  } catch { /* non-browser / private mode */ }
  try {
    return (import.meta.env.VITE_API_TOKEN as string | undefined) ?? 'dev-user';
  } catch { return 'dev-user'; }
}

export function useRunChannel(runId: string | null) {
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<WsRunEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retryRef = useRef(0);
  const runIdRef = useRef(runId);
  runIdRef.current = runId;
  const terminalRef = useRef(false);

  // Authoritative fetch (DB), used on mount + every reconnect.
  async function refetch() {
    if (!runIdRef.current) return;
    try {
      const fresh = await api.get<Run>(`/runs/${runIdRef.current}`);
      setRun(fresh);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch run');
    }
  }

  useEffect(() => {
    if (!runId) return;
    setRun(null); setEvents([]); setError(null);
    let socket: WebSocket | null = null;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    void refetch(); // DB first — authoritative

    function connect() {
      if (closed) return;
      // WS requires ?token= (server closes unauthenticated handshakes with 4401).
      const ws = new WebSocket(`${wsUrl()}?runId=${encodeURIComponent(runIdRef.current!)}&token=${encodeURIComponent(wsToken())}`);
      socket = ws;
      ws.onopen = () => { setConnected(true); retryRef.current = 0; void refetch(); };
      ws.onclose = () => {
        setConnected(false);
        if (closed || terminalRef.current) return;
        // reconnect with backoff, then refetch (missed events are recovered from DB)
        const delay = Math.min(1000 * 2 ** retryRef.current++, 10000);
        retryTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => { ws.close(); };
      ws.onmessage = (msg) => {
        let parsed: { event?: string; payload?: Record<string, unknown> };
        try { parsed = JSON.parse(String(msg.data)); } catch { return; }
        const { event, payload } = parsed;
        if (!payload || typeof payload.runId !== 'string') return; // runId bắt buộc
        if (payload.runId !== runIdRef.current) return; // ignore other runs
        if (typeof event !== 'string' || !event.startsWith('run.') && !event.startsWith('step.')) return;
        setEvents((prev) => [...prev.slice(-199), { event: event as RunEventType, payload: payload as WsRunEvent['payload'] }]);
        applyEvent(payload.runId, event, payload);
      };
    }

    connect();
    return () => { closed = true; clearTimeout(retryTimer); socket?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useEffect(() => {
    terminalRef.current = !!run && TERMINAL.has(run.status);
  }, [run]);

  /** Merge informational event into local state; refetch on terminal events. */
  function applyEvent(_runId: string, event: string, payload: Record<string, unknown>) {
    if (event === 'run.queued' || event === 'run.started') {
      setRun((r) => (r ? { ...r, status: event === 'run.queued' ? 'queued' : 'running' } : r));
    } else if (event === 'step.started' || event === 'step.passed' || event === 'step.failed' || event === 'step.skipped') {
      const stepId = String(payload.stepId ?? '');
      const status =
        event === 'step.started' ? 'running'
        : event === 'step.passed' ? 'passed'
        : event === 'step.skipped' ? 'skipped'
        : 'failed';
      setRun((r) => {
        if (!r) return r;
        const steps = [...(r.steps ?? [])];
        const i = steps.findIndex((s) => s.stepId === stepId);
        const err = typeof payload.error === 'string' ? payload.error : undefined;
        if (i >= 0) steps[i] = { ...steps[i], status, ...(err ? { errorMessage: err } : {}) };
        else steps.push({ id: `ws-${stepId}`, runId: _runId, stepId, sortOrder: Number(payload.sortOrder ?? steps.length), status, errorMessage: err ?? null });
        return { ...r, status: r.status === 'queued' ? 'running' : r.status, steps };
      });
      if (event === 'step.failed') void refetch();
    } else if (event === 'step.healed') {
      // Proposal-only evidence (P2 healing never auto-applies): surface it on
      // the failed step; the authoritative proposal lives in GET healing.
      const stepId = String(payload.stepId ?? '');
      setRun((r) => {
        if (!r) return r;
        const steps = [...(r.steps ?? [])];
        const i = steps.findIndex((s) => s.stepId === stepId);
        if (i >= 0) steps[i] = { ...steps[i], healEvidence: payload['evidence'] ?? null };
        return { ...r, steps };
      });
    } else if (event === 'run.passed' || event === 'run.failed' || event === 'run.cancelled') {
      void refetch(); // terminal: DB authoritative
    }
  }

  return { run, events, connected, error, refetch };
}
