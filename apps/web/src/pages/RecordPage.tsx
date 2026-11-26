import { useEffect, useState } from "react";import { Link, useParams } from "react-router-dom";
import { Badge, Button, CopyId, Field, Input, useToast } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { RecorderLiveView } from "../components/RecorderLiveView";

/** /tests/:id/record — thin wrapper over recorder REST endpoints. */
export function RecordPage() {
  const { id } = useParams();
  const toast = useToast();
  const [baseUrl, setBaseUrl] = useState("https://example.com");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<Array<{ sessionId: string; testId: string; status: string; draftCount: number }>>([]);

  const loadActive = async () => {
    try {
      setActive(await api.listRecorderSessions());
    } catch {
      setActive([]);
    }
  };

  useEffect(() => {
    void loadActive();
  }, []);

  const call = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.push("success", ok);
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Recorder call failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-2xl space-y-4 p-6">
      <Link to={`/tests/${id}`} className="text-sm text-slate-500 hover:text-slate-800">
        ← Back to builder
      </Link>
      <h1 className="text-xl font-semibold">Record session</h1>
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
        <span className="inline-flex items-center gap-2">Test <CopyId id={id ?? ""} label="test" /></span>
        {sessionId ? (
          <Badge tone="indigo">session <CopyId id={sessionId} label="session" /></Badge>
        ) : (
          <Badge>not started</Badge>
        )}
        {sessionId && paused ? <Badge tone="amber">paused</Badge> : null}
        {sessionId && !paused ? <Badge tone="green">recording</Badge> : null}
      </div>

      <ol className="space-y-2 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
        {[
          "Enter the Base URL, then Start — a live browser view appears here (no local install needed).",
          "Click inside the live view and interact: each click/keystroke is recorded as a step.",
          "Pause when you need a break; Resume to continue.",
          "Stop to merge the steps into the builder, then review.",
        ].map((s, i) => (
          <li key={i} className="flex gap-2.5">
            <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
              sessionId ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"
            }`}>{i + 1}</span>
            <span className="text-slate-700">{s}</span>
          </li>
        ))}
      </ol>

      {active.length > 0 ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          <div className="mb-1 flex items-center justify-between">
            <strong className="text-amber-900">Active recorder sessions: {active.length}</strong>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                call(async () => {
                  const r = await api.stopAllRecorderSessions();
                  setSessionId(null);
                  setPaused(false);
                  await loadActive();
                  toast.push("info", `${r.stopped} session(s) closed — drafts kept.`);
                }, "Sessions closed.")
              }
            >
              Stop all my sessions
            </Button>
          </div>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-900">
            {active.map((s) => (
              <li key={s.sessionId}>
                {s.status} · test <code>{s.testId.slice(0, 10)}…</code> · {s.draftCount} draft step(s)
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-amber-800">
            A forgotten session keeps a real browser open on the server. Close it here, or it is closed automatically after 30 minutes idle.
          </p>
        </div>
      ) : null}

      <Field label="Base URL">
        <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={!!sessionId} />
      </Field>

      {sessionId ? <RecorderLiveView sessionId={sessionId} /> : null}

      <div className="flex flex-wrap gap-2">
        {!sessionId ? (
          <Button
            disabled={busy || !id}
            onClick={() =>
              call(async () => {
                const r = await api.recorderStart(id!, baseUrl || undefined);
                setSessionId(r.sessionId);
              }, "Recorder started.")
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
                onClick={() => call(() => api.recorderPause(sessionId).then(() => setPaused(true)), "Paused.")}
              >
                ⏸ Pause
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => call(() => api.recorderResume(sessionId).then(() => setPaused(false)), "Resumed.")}
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
                }, "Stopped — recorded steps were merged into the builder.")
              }
            >
              ■ Stop
            </Button>
          </>
        )}
      </div>
      <p className="text-xs text-slate-500">
        Recorder events stream over WS <code>/ws?sessionId=…</code>; the DB is the source of truth on
        reconnect (see apps/server/src/app.ts). After stopping, return to the builder to review the steps.
      </p>
    </main>
  );
}
