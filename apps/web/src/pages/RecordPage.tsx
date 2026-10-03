import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge, Button, Field, Input, useToast } from "../components/ui";
import { ApiError, api } from "../lib/api";

/** /tests/:id/record — thin wrapper over recorder REST endpoints. */
export function RecordPage() {
  const { id } = useParams();
  const toast = useToast();
  const [baseUrl, setBaseUrl] = useState("https://example.com");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);

  const call = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.push("success", ok);
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Recorder call thất bại");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-2xl space-y-4 p-6">
      <Link to={`/tests/${id}`} className="text-sm text-slate-500 hover:text-slate-800">
        ← Về builder
      </Link>
      <h1 className="text-xl font-semibold">Record session</h1>
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
        <span>Test <code className="rounded bg-slate-100 px-1 font-mono text-xs">{id}</code></span>
        {sessionId ? (
          <Badge tone="indigo">session {sessionId.slice(0, 12)}…</Badge>
        ) : (
          <Badge>chưa start</Badge>
        )}
        {sessionId && paused ? <Badge tone="amber">paused</Badge> : null}
        {sessionId && !paused ? <Badge tone="green">recording</Badge> : null}
      </div>

      <ol className="space-y-2 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
        {[
          "Nhập Base URL rồi Start — browser headed bật lên trên máy chạy server.",
          "Thao tác trên trang web: mỗi click/gõ được ghi thành step.",
          "Pause khi cần nghỉ; Resume để tiếp tục.",
          "Stop để merge steps vào builder rồi review.",
        ].map((s, i) => (
          <li key={i} className="flex gap-2.5">
            <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
              sessionId ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"
            }`}>{i + 1}</span>
            <span className="text-slate-700">{s}</span>
          </li>
        ))}
      </ol>

      <Field label="Base URL">
        <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={!!sessionId} />
      </Field>

      <div className="flex flex-wrap gap-2">
        {!sessionId ? (
          <Button
            disabled={busy || !id}
            onClick={() =>
              call(async () => {
                const r = await api.recorderStart(id!, baseUrl || undefined);
                setSessionId(r.sessionId);
              }, "Đã start recorder.")
            }
          >
            ● Start
          </Button>
        ) : (
          <>
            {!paused ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => call(() => api.recorderPause(sessionId).then(() => setPaused(true)), "Đã pause.")}
              >
                ⏸ Pause
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => call(() => api.recorderResume(sessionId).then(() => setPaused(false)), "Đã resume.")}
              >
                ▶ Resume
              </Button>
            )}
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                call(async () => {
                  await api.recorderStop(sessionId);
                  setSessionId(null);
                  setPaused(false);
                }, "Đã stop — steps ghi được merge vào builder.")
              }
            >
              ■ Stop
            </Button>
          </>
        )}
      </div>
      <p className="text-xs text-slate-500">
        Recorder events đẩy qua WS <code>/ws?sessionId=…</code>; DB là source of truth khi
        reconnect (xem apps/server/src/app.ts). Stop xong quay lại builder để review steps.
      </p>
    </main>
  );
}
