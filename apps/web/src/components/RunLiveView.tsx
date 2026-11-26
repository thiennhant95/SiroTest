import { useEffect, useRef, useState } from "react";

/**
 * Read-only live view of a running test. The runner launches Chromium with a
 * CDP port; the server streams JPEG frames over WS (`run.screencast`). No input
 * is forwarded — runs stay deterministic.
 */
export function RunLiveView({ runId, active }: { runId: string; active: boolean }) {
  const [frame, setFrame] = useState("");
  const [status, setStatus] = useState<"connecting" | "live" | "idle">("connecting");
  const [zoom, setZoom] = useState<"fit" | "1.5" | "2">("fit");
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!active) {
      setStatus("idle");
      return;
    }
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const token = (() => {
      try {
        return localStorage.getItem("vv_token") ?? "dev-user";
      } catch {
        return "dev-user";
      }
    })();
    const ws = new WebSocket(`${proto}://${window.location.host}/ws?token=${encodeURIComponent(token)}&runId=${encodeURIComponent(runId)}`);
    wsRef.current = ws;
    ws.onopen = () => setStatus("connecting");
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as { event?: string; payload?: { data?: string; runId?: string } };
        if (msg.event === "run.screencast" && msg.payload?.data && msg.payload.runId === runId) {
          setFrame(`data:image/jpeg;base64,${msg.payload.data}`);
          setStatus("live");
        }
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => setStatus((s) => (s === "live" ? "live" : s));
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [runId, active]);

  if (!active && !frame) return null;

  return (
    <section aria-label="Live browser" className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className={`inline-block h-2 w-2 rounded-full ${status === "live" ? "bg-green-500" : "bg-amber-400"}`} />
        {status === "live" ? "Live browser (read-only)" : active ? "Waiting for the browser to start…" : "Run finished"}
        <span className="ml-auto flex items-center gap-1">
          {(["fit", "1.5", "2"] as const).map((z) => (
            <button
              key={z}
              type="button"
              onClick={() => setZoom(z)}
              className={`rounded border px-2 py-0.5 ${zoom === z ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
            >
              {z === "fit" ? "Fit" : `${Number(z) * 100}%`}
            </button>
          ))}
        </span>
      </div>
      <div className="max-h-[70vh] overflow-auto rounded-lg border border-slate-300 bg-slate-900">
        {frame ? (
          <img
            src={frame}
            alt="Live browser"
            draggable={false}
            className="block select-none"
            style={{ width: zoom === "fit" ? "100%" : `${Number(zoom) * 100}%`, maxWidth: "none" }}
          />
        ) : (
          <div className="flex h-48 items-center justify-center text-sm text-slate-400">
            {active ? "The browser window appears when the test starts." : "No frames captured."}
          </div>
        )}
      </div>
    </section>
  );
}
