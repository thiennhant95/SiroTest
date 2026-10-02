/**
 * Recorder WS subscription (Day 5-6: Locator picker live mode).
 *
 * Server broadcasts over GET /ws (app.ts): every frame is
 * `{ event, payload }` with payload always carrying sessionId.
 * The picker listens for `recorder.locatorPicked` and normalizes the
 * payload into { primary, alternatives } for the Inspector.
 */
import { useEffect, useRef, useState } from "react";
import type { LocatorCandidate } from "./locator";

export interface PickedLocator {
  primary: LocatorCandidate;
  alternatives: LocatorCandidate[];
}

export type WsStatus = "idle" | "connecting" | "open" | "closed" | "error";

export function wsUrlFromApiBase(apiBase: string): string {
  const base = apiBase.replace(/\/$/, "");
  const ws = base.replace(/^http/, "ws");
  return `${ws}/ws`;
}

function isCandidate(v: unknown): v is LocatorCandidate {
  if (typeof v !== "object" || v === null) return false;
  const s = (v as { strategy?: unknown }).strategy;
  return (
    s === "role" ||
    s === "label" ||
    s === "placeholder" ||
    s === "testId" ||
    s === "text" ||
    s === "css" ||
    s === "xpath"
  );
}

function asCandidates(v: unknown): LocatorCandidate[] {
  return Array.isArray(v) ? v.filter(isCandidate) : [];
}

/**
 * Normalize a `recorder.locatorPicked` payload. Accepts:
 *   { locator, ... } | { primary, alternatives } | { candidate, alternatives }
 * Returns null when the payload carries no usable candidate (P0 server emits
 * the event with session info only until the bridge sends element detail).
 */
export function extractPickedLocator(
  payload: Record<string, unknown>,
): PickedLocator | null {
  const primaryRaw =
    payload.locator ?? payload.primary ?? payload.candidate ?? null;
  const primary = isCandidate(primaryRaw)
    ? primaryRaw
    : Array.isArray(primaryRaw)
      ? primaryRaw.find(isCandidate) ?? null
      : null;
  if (!primary) return null;
  return {
    primary,
    alternatives: asCandidates(
      payload.alternatives ?? (payload.locator as { alternatives?: unknown })?.alternatives,
    ),
  };
}

export function useRecorderEvents(opts: {
  wsUrl: string | null;
  onEvent: (event: string, payload: Record<string, unknown>) => void;
}): { status: WsStatus; lastEvent: string | null } {
  const [status, setStatus] = useState<WsStatus>("idle");
  const [lastEvent, setLastEvent] = useState<string | null>(null);
  const handlerRef = useRef(opts.onEvent);
  handlerRef.current = opts.onEvent;

  useEffect(() => {
    if (!opts.wsUrl) {
      setStatus("idle");
      return;
    }
    setStatus("connecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket(opts.wsUrl);
    } catch {
      setStatus("error");
      return;
    }
    socket.onopen = () => setStatus("open");
    socket.onclose = () => setStatus("closed");
    socket.onerror = () => setStatus("error");
    socket.onmessage = (msg) => {
      try {
        const frame = JSON.parse(String(msg.data)) as {
          event?: string;
          payload?: Record<string, unknown>;
        };
        if (!frame.event) return;
        setLastEvent(frame.event);
        handlerRef.current(frame.event, frame.payload ?? {});
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    };
  }, [opts.wsUrl]);

  return { status, lastEvent };
}
