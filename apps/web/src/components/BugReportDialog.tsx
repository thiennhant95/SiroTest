import { useEffect, useState } from "react";
import { ApiError, api, type Integration } from "../lib/api";
import { Button, Dialog, Field, Input, Select } from "./ui";

/** Bug-from-failure: preview markdown, download .md, or file to Jira/Backlog/Slack/Lark. */
export function BugReportDialog({ runId, projectId, open, onClose }: { runId: string; projectId: string; open: boolean; onClose: () => void }) {
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [preview, setPreview] = useState<{ title: string; markdown: string } | null>(null);
  const [summary, setSummary] = useState("");
  const [target, setTarget] = useState("");
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{ provider: string; externalId?: string; externalUrl?: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setPreview(null);
    setErr("");
    setDone(null);
    setSummary("");
    api
      .bugPreview(runId)
      .then((p) => {
        if (!alive) return;
        setPreview(p);
        setSummary(p.title);
      })
      .catch((e) => {
        if (alive) setErr(e instanceof ApiError ? e.message : "Couldn't build the report");
      });
    api
      .listIntegrations(projectId)
      .then((list) => {
        if (alive) setIntegrations(list.filter((x) => x.enabled));
      })
      .catch(() => {
        if (alive) setIntegrations([]);
      });
    return () => {
      alive = false;
    };
  }, [open, runId, projectId]);

  const download = () => {
    if (!preview) return;
    const blob = new Blob([`# ${summary || preview.title}\n\n${preview.markdown}`], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = `${runId}.bug.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  };

  const send = async () => {
    if (!target) return;
    setBusy(true);
    setErr("");
    try {
      const res = await api.bugReport(runId, { integrationId: target, summary: summary.trim() || undefined, attachScreenshots: attach || undefined });
      setDone(res.delivery);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Delivery failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Report bug" wide>
      <div className="space-y-3 px-4 py-4">
        {err ? (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {err}
          </p>
        ) : null}
        {!preview ? (
          <p className="text-sm text-slate-500">Building the report…</p>
        ) : (
          <>
            <Field label="Summary (ticket title)">
              <Input value={summary} onChange={(e) => setSummary(e.target.value)} />
            </Field>
            <div>
              <p className="mb-1 text-xs font-medium text-slate-600">Preview (Markdown)</p>
              <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-xs">
                {preview.markdown}
              </pre>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Field label="Send to">
                <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Integration target">
                  <option value="">Markdown only (no send)</option>
                  {(integrations ?? []).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.provider}: {x.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex items-end gap-2">
                <Button type="button" variant="outline" onClick={download} disabled={!preview}>
                  ⬇ .md
                </Button>
                <Button type="button" onClick={() => void send()} disabled={busy || !target || !preview}>
                  {busy ? "Sending…" : "Send"}
                </Button>
              </div>
            </div>
            <label className="flex items-center gap-1.5 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={attach}
                onChange={(e) => setAttach(e.target.checked)}
                className="h-4 w-4 accent-indigo-600"
              />
              Attach run screenshots (Backlog, max 5)
            </label>
            {integrations !== null && integrations.length === 0 ? (
              <p className="text-xs text-slate-500">
                No integrations yet — add Jira / Backlog / Slack / Lark in project Settings → Integrations. Secrets stay encrypted server-side.
              </p>
            ) : null}
            {done ? (
              <p role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
                Filed to {done.provider}
                {done.externalId ? <> as <strong>{done.externalId}</strong></> : null}
                {done.externalUrl ? (
                  <>
                    {" "}· <a href={done.externalUrl} target="_blank" rel="noreferrer" className="underline">open</a>
                  </>
                ) : null}
                .
              </p>
            ) : null}
          </>
        )}
        <div className="flex justify-end border-t border-slate-200 pt-3">
          <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Dialog>
  );
}
