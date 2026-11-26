import { useEffect, useRef, useState } from "react";

/**
 * Live view of the recorder's browser (remote recording).
 *
 * The browser runs on the server host; this component shows CDP screencast
 * frames and forwards mouse/keyboard input back over the same WS channel.
 * Coordinates are sent normalized (0..1) and scaled server-side against the
 * frame metadata, so it works at any display size.
 */
export function RecorderLiveView({ sessionId }: { sessionId: string }) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "error">("connecting");
  const [frame, setFrame] = useState<string>("");
  const [message, setMessage] = useState<string>("");
  const [zoom, setZoom] = useState<"fit" | "1.5" | "2">("fit");

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const token = (() => {
      try {
        return localStorage.getItem("vv_token") ?? "dev-user";
      } catch {
        return "dev-user";
      }
    })();
    const ws = new WebSocket(`${proto}://${window.location.host}/ws?token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(sessionId)}`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ sessionId, stream: "start" }));
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as {
          event?: string;
          payload?: { data?: string; code?: string; message?: string };
        };
        if (msg.event === "recorder.screencast" && msg.payload?.data) {
          setFrame(`data:image/jpeg;base64,${msg.payload.data}`);
          setStatus("live");
        } else if (msg.event === "error") {
          setStatus("error");
          setMessage(msg.payload?.message ?? msg.payload?.code ?? "Live view error");
        }
      } catch {
        /* ignore */
      }
    };
    ws.onerror = () => {
      setStatus("error");
      setMessage("Connection to live view failed");
    };
    ws.onclose = () => {
      setStatus((s) => (s === "live" ? "error" : s));
    };

    return () => {
      try {
        ws.send(JSON.stringify({ sessionId, stream: "stop" }));
      } catch {
        /* already closed */
      }
      ws.close();
      wsRef.current = null;
    };
  }, [sessionId]);

  function send(input: Record<string, unknown>) {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ sessionId, input }));
  }

  function point(e: React.MouseEvent<HTMLImageElement>) {
    const el = imgRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className={`inline-block h-2 w-2 rounded-full ${status === "live" ? "bg-green-500" : status === "error" ? "bg-red-500" : "bg-amber-400"}`} />
        {status === "live" ? "Live view — click and type here" : status === "connecting" ? "Connecting to the browser…" : `Live view unavailable${message ? `: ${message}` : ""}`}
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
          <button
            type="button"
            onClick={() => {
              const el = boxRef.current;
              if (!el) return;
              if (document.fullscreenElement) void document.exitFullscreen();
              else void el.requestFullscreen?.();
            }}
            className="rounded border border-slate-300 px-2 py-0.5 text-slate-600 hover:bg-slate-50"
          >
            Fullscreen
          </button>
        </span>
      </div>
      <div
        ref={boxRef}
        className="overflow-auto rounded-lg border border-slate-300 bg-slate-900"
        tabIndex={0}
        onKeyDown={(e) => {
          const key = e.key;
          if (key.length === 1) {
            send({ kind: "text", text: key });
          } else {
            send({ kind: "key", type: "keyDown", key, code: e.code, keyCode: e.keyCode });
            send({ kind: "key", type: "keyUp", key, code: e.code, keyCode: e.keyCode });
          }
          if (key === "Backspace" || key === "Enter" || key === "Tab" || key.startsWith("Arrow")) {
            send({ kind: "key", type: "keyDown", key, code: e.code, keyCode: e.keyCode });
            send({ kind: "key", type: "keyUp", key, code: e.code, keyCode: e.keyCode });
          }
        }}
        onWheel={(e) => {
          send({ kind: "wheel", deltaY: e.deltaY });
        }}
      >
        <img
          ref={imgRef}
          src={frame || undefined}
          alt="Live browser"
          draggable={false}
          className="block cursor-crosshair select-none"
          style={{ width: zoom === "fit" ? "100%" : `${Number(zoom) * 100}%`, maxWidth: "none" }}
          onMouseDown={(e) => {
            const p = point(e);
            send({ kind: "mouse", type: "mousePressed", button: e.button === 2 ? "right" : "left", clickCount: 1, x: p.x, y: p.y });
          }}
          onMouseUp={(e) => {
            const p = point(e);
            send({ kind: "mouse", type: "mouseReleased", button: e.button === 2 ? "right" : "left", clickCount: 1, x: p.x, y: p.y });
          }}
          onContextMenu={(e) => e.preventDefault()}
        />
        {!frame ? <div className="flex h-64 items-center justify-center text-sm text-slate-400">Waiting for the first frame…</div> : null}
      </div>
      <p className="text-xs text-slate-500">
        Click inside the frame first, then use the mouse/keyboard. Steps are recorded exactly like a local session.
      </p>
    </div>
  );
}
