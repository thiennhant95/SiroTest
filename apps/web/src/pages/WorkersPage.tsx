/**
 * P2 — Distributed workers board (/workers, wired in App.tsx).
 *
 * BACKEND CONTRACT (apps/server/src/routes/workers.ts):
 *   POST /api/v1/workers/register {name, capacity?} -> 201 Worker
 *   GET  /api/v1/workers -> Worker[] + {activeClaims, claimedRuns}
 *   POST /api/v1/workers/:id/heartbeat -> {worker, claimedRun|null}
 *   POST /api/v1/workers/:id/complete {runId, status, errorSummary?, durationMs?}
 *   POST /api/v1/workers/:id/deregister -> {worker, releasedQueuedRuns}
 *   POST /api/v1/workers/sweep -> {staleWorkers, releasedRuns}
 *
 * LIMIT (honest, also shown in-UI): true distribution needs a SHARED DB
 * (Postgres). With the default SQLite file, only processes on the same host
 * sharing the same file see the same queue.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { isNotFoundError } from "../lib/api";
import { EmptyState, ErrorState, Skeleton, useToast } from "../components/ui";

const API = "/api/v1";

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

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

interface ClaimedRun {
  id: string;
  status: string;
  testId: string;
  projectId: string;
}

interface WorkerRow {
  id: string;
  name: string;
  status: string;
  capacity: number;
  lastHeartbeatAt: string | null;
  activeClaims: number;
  claimedRuns: ClaimedRun[];
}

export function WorkersPage() {
  const toast = useToast();
  const [workers, setWorkers] = useState<WorkerRow[] | null>(null);
  const [error, setError] = useState("");
  const [unsupported, setUnsupported] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    setUnsupported(false);
    try {
      setWorkers(await req<WorkerRow[]>("GET", `${API}/workers`));
    } catch (e) {
      if (isNotFoundError(e)) {
        setUnsupported(true);
        setWorkers([]);
      } else {
        setWorkers([]);
        setError(e instanceof Error ? e.message : "Không tải được workers");
      }
    }
  }, []);

  useEffect(() => {
    setWorkers(null);
    void load();
  }, [load]);

  async function register() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await req("POST", `${API}/workers/register`, { name: name.trim(), capacity: 2 });
      setName("");
      toast.push("success", "Đã đăng ký worker.");
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Register thất bại";
      setError(msg);
      toast.push("error", msg);
    } finally {
      setBusy(false);
    }
  }

  async function deregister(id: string) {
    try {
      await req("POST", `${API}/workers/${id}/deregister`);
      toast.push("success", "Đã gỡ worker.");
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Deregister thất bại";
      setError(msg);
      toast.push("error", msg);
    }
  }

  async function sweep() {
    try {
      const r = await req<{ staleWorkers: string[]; releasedRuns: string[] }>("POST", `${API}/workers/sweep`);
      const msg = r.staleWorkers.length === 0 ? "Không có worker stale." : `Sweep: ${r.staleWorkers.length} stale, ${r.releasedRuns.length} runs released`;
      setError(r.staleWorkers.length === 0 ? "" : msg);
      toast.push("success", msg);
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sweep thất bại";
      setError(msg);
      toast.push("error", msg);
    }
  }

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-6">
      <Link to="/projects" className="text-sm text-slate-500 hover:text-slate-800">
        ← Projects
      </Link>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Workers</h1>
        <button className="rounded border px-3 py-1 text-sm" onClick={() => void sweep()}>
          Sweep stale (90s)
        </button>
      </div>
      <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        DB job-claim protocol, không thêm infra. Distributed thật cần shared DB (Postgres) —
        SQLite file-local chỉ demo trên cùng host. Chi tiết: <code>docs/oidc-sso.md</code> (SSO) và
        server route <code>apps/server/src/routes/workers.ts</code> header.
      </p>
      <div className="flex gap-2 text-sm">
        <input
          className="rounded border px-2 py-1"
          placeholder="worker name (vd edge-01)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="rounded border px-3 py-1" disabled={busy} onClick={() => void register()}>
          {busy ? "…" : "Register"}
        </button>
      </div>
      {unsupported ? (
        <EmptyState
          title="Backend chưa hỗ trợ workers (API 404)"
          hint="UI đã sẵn sàng theo contract POST/GET /workers. Đợi backend P2 rồi reload — in-process runQueue vẫn là executor mặc định."
        />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : null}
      {workers === null ? (
        <div className="space-y-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : !unsupported && !error && workers.length === 0 ? (
        <EmptyState
          title="Chưa có worker nào"
          hint="In-process runQueue vẫn là executor mặc định. Đăng ký worker đầu tiên ở ô phía trên."
        />
      ) : workers.length === 0 ? null : (
        <ul className="space-y-2">
          {workers.map((w) => (
            <li key={w.id} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <strong>{w.name}</strong>
                <span
                  className={`rounded px-2 py-0.5 text-xs ${w.status === "online" ? "bg-green-100 text-green-800" : "bg-slate-200 text-slate-600"}`}
                >
                  {w.status}
                </span>
                <span className="text-xs text-slate-500">
                  cap {w.capacity} · active {w.activeClaims} · heartbeat {w.lastHeartbeatAt ?? "—"}
                </span>
                <button className="ml-auto text-xs text-red-600 hover:underline" onClick={() => void deregister(w.id)}>
                  Deregister
                </button>
              </div>
              {w.claimedRuns.length > 0 ? (
                <ul className="mt-2 space-y-1 text-xs">
                  {w.claimedRuns.map((r) => (
                    <li key={r.id} className="font-mono">
                      <Link to={`/runs/${r.id}`} className="text-indigo-700 hover:underline">{r.id.slice(0, 8)}</Link>
                      <span className="text-slate-500"> {r.status} · test {r.testId.slice(0, 8)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
