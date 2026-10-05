/**
 * P2 — Audit log (/projects/:id/audit, wired in App.tsx).
 *
 * BACKEND CONTRACT (apps/server/src/routes/audit.ts):
 *   GET /api/v1/projects/:id/audit?action=&userId=&limit=&offset=
 *     -> AuditLog[] (newest first, details JSON with sensitive keys masked)
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { isNotFoundError } from "../lib/api";
import { EmptyState, ErrorState, Skeleton, useToast } from "../components/ui";

const API = "/api/v1";
const PAGE = 50;

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const t = localStorage.getItem("vv_token");
    if (t) h.Authorization = `Bearer ${t}`;
  } catch {
    /* ignore */
  }
  return h;
}

interface AuditRow {
  id: string;
  userId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: string | null;
  createdAt: string;
}

export function AuditPage() {
  const { id: projectId } = useParams();
  const toast = useToast();
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState("");
  const [unsupported, setUnsupported] = useState(false);
  const [fAction, setFAction] = useState("");
  const [fUser, setFUser] = useState("");
  const [offset, setOffset] = useState(0);

  const load = useCallback(
    async (off: number) => {
      if (!projectId) return;
      setError("");
      setUnsupported(false);
      setRows(null);
      const p = new URLSearchParams({ limit: String(PAGE), offset: String(off) });
      if (fAction.trim()) p.set("action", fAction.trim());
      if (fUser.trim()) p.set("userId", fUser.trim());
      try {
        const res = await fetch(`${API}/projects/${projectId}/audit?${p}`, { headers: headers() });
        if (res.status === 404) {
          setUnsupported(true);
          setRows([]);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        setRows((await res.json()) as AuditRow[]);
      } catch (e) {
        if (isNotFoundError(e)) {
          setUnsupported(true);
          setRows([]);
        } else {
          setRows([]);
          const msg = e instanceof Error ? e.message : "Couldn't load audit log";
          setError(msg);
          toast.push("error", msg);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, fAction, fUser],
  );

  useEffect(() => {
    setOffset(0);
    void load(0);
  }, [load]);

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-6">
      <Link to={`/projects/${projectId}`} className="text-sm text-slate-500 hover:text-slate-800">
        ← Project
      </Link>
      <h1 className="text-xl font-semibold">Audit log</h1>
      <div className="flex flex-wrap gap-2 text-sm">
        <input
          className="rounded border px-2 py-1"
          placeholder="filter action (e.g. worker.claim)"
          value={fAction}
          onChange={(e) => setFAction(e.target.value)}
        />
        <input
          className="rounded border px-2 py-1"
          placeholder="filter user id"
          value={fUser}
          onChange={(e) => setFUser(e.target.value)}
        />
        <button className="rounded border px-3 py-1" onClick={() => { setOffset(0); void load(0); }}>
          Filter
        </button>
      </div>
      {unsupported ? (
        <EmptyState
          title="Backend audit not supported (API 404)"
          hint="UI is ready per contract GET /projects/:id/audit. Waiting on P2 backend — reload later."
        />
      ) : error ? (
        <ErrorState message={error} onRetry={() => { setOffset(0); void load(0); }} />
      ) : null}
      {rows === null ? (
        <div className="space-y-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : !unsupported && !error && rows.length === 0 ? (
        <EmptyState title="No audit entries yet" hint="Logged operations (worker claim, healing approve, etc.) will appear here." />
      ) : rows.length === 0 ? null : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th>Time</th><th>Action</th><th>User</th><th>Entity</th><th>Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t align-top">
                  <td className="whitespace-nowrap text-xs">{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="font-mono text-xs">{r.action}</td>
                  <td className="text-xs">{r.userId ?? "—"}</td>
                  <td className="text-xs">{r.entityType ? `${r.entityType}:${r.entityId?.slice(0, 8)}` : "—"}</td>
                  <td className="max-w-md truncate font-mono text-xs text-slate-500">{r.details ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex gap-2 text-sm">
            <button
              className="rounded border px-3 py-1 disabled:opacity-40"
              disabled={offset === 0}
              onClick={() => { const n = Math.max(0, offset - PAGE); setOffset(n); void load(n); }}
            >
              ← Prev
            </button>
            <button
              className="rounded border px-3 py-1 disabled:opacity-40"
              disabled={rows.length < PAGE}
              onClick={() => { const n = offset + PAGE; setOffset(n); void load(n); }}
            >
              Next →
            </button>
          </div>
        </>
      )}
    </main>
  );
}
