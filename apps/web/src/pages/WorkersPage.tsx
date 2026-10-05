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
import { Badge, Button, EmptyState, ErrorState, Field, Input, Skeleton, useToast } from "../components/ui";

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
  // NOTE: Fastify rejects content-type json with an empty body — bodiless
  // POSTs must send '{}' explicitly.
  const res = await fetch(url, {
    method,
    headers: headers(),
    body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body),
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
        setError(e instanceof Error ? e.message : "Couldn't load workers");
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
      toast.push("success", "Registered worker.");
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Registration failed";
      setError(msg);
      toast.push("error", msg);
    } finally {
      setBusy(false);
    }
  }

  async function deregister(id: string) {
    try {
      await req("POST", `${API}/workers/${id}/deregister`);
      toast.push("success", "Removed worker.");
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't deregister";
      setError(msg);
      toast.push("error", msg);
    }
  }

  async function sweep() {
    try {
      const r = await req<{ staleWorkers: string[]; releasedRuns: string[] }>("POST", `${API}/workers/sweep`);
      const msg = r.staleWorkers.length === 0 ? "No stale workers." : `Sweep: ${r.staleWorkers.length} stale, ${r.releasedRuns.length} runs released`;
      setError(r.staleWorkers.length === 0 ? "" : msg);
      toast.push("success", msg);
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sweep failed";
      setError(msg);
      toast.push("error", msg);
    }
  }

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-6">
      <Link to="/projects" className="text-sm text-slate-500 hover:text-slate-800">
        ← Projects
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Workers</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Distributed run executors. The in-process queue stays the default — workers take over when registered.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void sweep()} title="Release runs claimed by dead workers">
          Sweep stale (90s)
        </Button>
      </div>
      <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
        DB job-claim protocol, no extra infra. True distribution needs a <strong>shared DB (Postgres)</strong> —
        file-local SQLite is only a same-host demo.
      </p>
      <div className="grid grid-cols-[1fr_auto] items-end gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3">
        <Field label="Worker name">
          <Input placeholder="edge-01" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Button onClick={() => void register()} disabled={busy || !name.trim()}>
          {busy ? "…" : "Register"}
        </Button>
      </div>
      {unsupported ? (
        <EmptyState
          title="Backend workers not supported (API 404)"
          hint="UI is ready per contract POST/GET /workers. Waiting on P2 backend — reload; the in-process runQueue remains the default executor."
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
          title="No workers yet"
          hint="The in-process runQueue remains the default executor. Register your first worker above."
        />
      ) : workers.length === 0 ? null : (
        <ul className="space-y-2">
          {workers.map((w) => {
            const load = w.capacity > 0 ? Math.min(100, Math.round((w.activeClaims / w.capacity) * 100)) : 0;
            return (
            <li key={w.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-sm">{w.name}</strong>
                <Badge tone={w.status === "online" ? "green" : "slate"}>{w.status}</Badge>
                <span className="font-mono text-[11px] text-slate-400">{w.id.slice(0, 12)}…</span>
                <Button type="button" size="sm" variant="ghost" className="ml-auto text-red-600 hover:text-red-700" onClick={() => void deregister(w.id)}>
                  Deregister
                </Button>
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                <span className="shrink-0">load {w.activeClaims}/{w.capacity}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200" aria-hidden>
                  <span className={`block h-full rounded-full ${load >= 100 ? "bg-red-500" : load > 0 ? "bg-indigo-500" : "bg-slate-300"}`} style={{ width: `${load}%` }} />
                </span>
                <span className="shrink-0">heartbeat {w.lastHeartbeatAt ? new Date(w.lastHeartbeatAt).toLocaleTimeString() : "—"}</span>
              </div>
              {w.claimedRuns.length > 0 ? (
                <ul className="mt-2 space-y-1 border-t border-slate-100 pt-2 text-xs">
                  {w.claimedRuns.map((r) => (
                    <li key={r.id} className="font-mono">
                      <Link to={`/runs/${r.id}`} className="text-indigo-700 hover:underline">{r.id.slice(0, 8)}</Link>
                      <span className="text-slate-500"> {r.status} · test {r.testId.slice(0, 8)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
