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
import { Badge, Button, DataTable, EmptyState, ErrorState, Field, Input, Skeleton, useToast } from "../components/ui";

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
      <p className="text-sm text-slate-500">
        Newest first. Sensitive details are masked by the server.
      </p>
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="min-w-52 flex-1">
          <Field label="Action filter" hint="e.g. worker.claim">
            <Input
              placeholder="Filter action (e.g. worker.claim)"
              value={fAction}
              onChange={(e) => setFAction(e.target.value)}
            />
          </Field>
        </div>
        <div className="min-w-52 flex-1">
          <Field label="User filter" hint="Exact user ID">
            <Input
              placeholder="Filter user ID"
              value={fUser}
              onChange={(e) => setFUser(e.target.value)}
            />
          </Field>
        </div>
        <Button size="sm" onClick={() => { setOffset(0); void load(0); }}>
          Apply filters
        </Button>
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
          <DataTable<AuditRow>
            caption={`${rows.length} entries (newest first)`}
            emptyText="No audit entries yet."
            rows={rows}
            columns={[
              {
                key: "createdAt",
                header: "Time",
                render: (r) => (
                  <span className="whitespace-nowrap text-xs">{new Date(r.createdAt).toLocaleString()}</span>
                ),
              },
              {
                key: "action",
                header: "Action",
                render: (r) => <Badge title={r.action}><span className="font-mono text-[11px]">{r.action}</span></Badge>,
              },
              {
                key: "userId",
                header: "User",
                render: (r) => (
                  r.userId ? <span className="font-mono text-xs">{r.userId}</span> : <span className="text-xs text-slate-400">—</span>
                ),
              },
              {
                key: "entityType",
                header: "Entity",
                render: (r) => (
                  <span className="font-mono text-xs">{r.entityType ? `${r.entityType}:${r.entityId?.slice(0, 8)}` : "—"}</span>
                ),
              },
              {
                key: "details",
                header: "Details",
                render: (r) => (
                  <span className="block max-w-md truncate font-mono text-xs text-slate-500" title={r.details ?? ""}>{r.details ?? "—"}</span>
                ),
              },
            ]}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={offset === 0}
              onClick={() => { const n = Math.max(0, offset - PAGE); setOffset(n); void load(n); }}
            >
              ← Prev
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={rows.length < PAGE}
              onClick={() => { const n = offset + PAGE; setOffset(n); void load(n); }}
            >
              Next →
            </Button>
          </div>
        </>
      )}
    </main>
  );
}
