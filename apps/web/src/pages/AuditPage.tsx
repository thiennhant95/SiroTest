/**
 * P2 — Audit log (/projects/:id/audit). NEW FILE, self-contained.
 *
 * BACKEND CONTRACT (apps/server/src/routes/audit.ts):
 *   GET /api/v1/projects/:id/audit?action=&userId=&limit=&offset=
 *     -> AuditLog[] (newest first, details JSON with sensitive keys masked)
 *
 * ROUTE CONTRACT (App.tsx maintainer wires — this file is NOT imported yet):
 *   <Route path="/projects/:id/audit" element={<AuditPage />} />
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

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
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState("");
  const [fAction, setFAction] = useState("");
  const [fUser, setFUser] = useState("");
  const [offset, setOffset] = useState(0);

  const load = useCallback(
    async (off: number) => {
      if (!projectId) return;
      setError("");
      setRows(null);
      const p = new URLSearchParams({ limit: String(PAGE), offset: String(off) });
      if (fAction.trim()) p.set("action", fAction.trim());
      if (fUser.trim()) p.set("userId", fUser.trim());
      try {
        const res = await fetch(`${API}/projects/${projectId}/audit?${p}`, { headers: headers() });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        setRows((await res.json()) as AuditRow[]);
      } catch (e) {
        setRows([]);
        setError(e instanceof Error ? e.message : "Không tải được audit log");
      }
    },
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
          placeholder="filter action (vd worker.claim)"
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
          Lọc
        </button>
      </div>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      {rows === null ? (
        <p className="text-sm text-slate-500">Đang tải…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">Chưa có audit entries.</p>
      ) : (
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
