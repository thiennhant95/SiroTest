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
      <p className="text-sm text-slate-500">
        Test <code>{id}</code> ·{" "}
        {sessionId ? (
          <Badge tone="indigo">session {sessionId}</Badge>
        ) : (
          <Badge>chưa start</Badge>
        )}{" "}
        {sessionId && paused ? <Badge tone="amber">paused</Badge> : null}
      </p>

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
