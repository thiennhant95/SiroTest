import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { p2api, type HealingProposal } from "../api/p2";
import { isNotFoundError } from "../lib/api";
import { locatorPreview } from "../lib/steps";
import { EmptyState, ErrorState, Badge, Button, Skeleton, useToast } from "../components/ui";

/**
 * P2 — reviewable locator healing (`/tests/:id/healing`, wired in App.tsx).
 *
 * Healing NEVER auto-applies: this page only lists proposals (primary →
 * alternative + evidence) and lets a human Approve (rewrites the step primary
 * + mints a new test version server-side) or Reject them. Builder links here
 * via a "Healing (N)" entry; back-links return with `?focusStep=<stepId>`.
 */
export const HEALING_ROUTE_PATH = "/tests/:id/healing";

function candidateOf(json: string): { primary: unknown } {
  try {
    return { primary: JSON.parse(json) as unknown };
  } catch {
    return { primary: null };
  }
}

function evidenceOf(p: HealingProposal): {
  tried: string[];
  matchCount?: number;
  preview?: string;
  verified?: boolean;
  durationMs?: number;
} {
  try {
    return (JSON.parse(p.evidence ?? "{}") ?? {}) as never;
  } catch {
    return { tried: [] };
  }
}

export function HealingPage() {
  const { id: testId } = useParams<{ id: string }>();
  const toast = useToast();
  const [proposals, setProposals] = useState<HealingProposal[]>([]);
  const [filter, setFilter] = useState<"pending" | "approved" | "rejected" | "all">("pending");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!testId) return;
    setLoading(true);
    setError(null);
    setUnsupported(false);
    try {
      setProposals(await p2api.listHealing(testId, filter));
    } catch (e) {
      if (isNotFoundError(e)) {
        setUnsupported(true);
        setProposals([]);
      } else {
        setError(e instanceof Error ? e.message : "Failed to load healing proposals");
      }
    } finally {
      setLoading(false);
    }
  }, [testId, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(pid: string, action: "approve" | "reject") {
    setBusy(pid);
    setError(null);
    try {
      if (action === "approve") await p2api.approveHealing(pid);
      else await p2api.rejectHealing(pid);
      toast.push("success", action === "approve" ? "Đã duyệt proposal (primary đã viết lại)." : "Đã từ chối proposal.");
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : `${action} failed`;
      setError(msg);
      toast.push("error", msg);
    } finally {
      setBusy(null);
    }
  }

  if (!testId) return <p>Missing test id.</p>;

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <Link to={`/tests/${testId}`} className="text-sm text-slate-500 hover:text-slate-800">
        ← Back to builder
      </Link>
      <div>
        <h1 className="text-xl font-semibold">Healing proposals</h1>
        <p className="mt-1 text-sm text-slate-500">
          A proposal is created when a stored alternative locator succeeded where the primary
          failed. Approving rewrites the step primary (old primary demoted to alternatives) and
          mints a new test version. Nothing is ever applied automatically.
        </p>
      </div>
      <div className="flex gap-1.5" role="tablist" aria-label="Filter proposals">
        {(["pending", "approved", "rejected", "all"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={filter === s}
            onClick={() => setFilter(s)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
              filter === s
                ? "bg-indigo-600 text-white"
                : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {s}
          </button>
        ))}
      </div>
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : unsupported ? (
        <EmptyState
          title="Backend chưa hỗ trợ healing (API 404)"
          hint="UI đã sẵn sàng theo contract GET /tests/:id/healing. Đợi backend P2 rồi reload."
        />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : proposals.length === 0 ? (
        <EmptyState title={`Không có proposal ${filter}`} hint="Proposal xuất hiện khi alternative locator thắng primary lúc run (có bật heal flag)." />
      ) : null}
      <ul className="space-y-3">
        {proposals.map((p) => {
          const ev = evidenceOf(p);
          return (
            <li key={p.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <strong>Step <code className="rounded bg-slate-100 px-1 font-mono text-xs">{p.stepId}</code></strong>
                <span className="text-slate-400">·</span>
                <span className="font-mono text-xs text-slate-500">{p.runId.slice(0, 12)}…</span>
                <Badge tone={p.status === "pending" ? "amber" : p.status === "approved" ? "green" : "slate"}>{p.status}</Badge>
              </div>
              <div className="mt-2 space-y-1 rounded-md bg-slate-50 p-2 font-mono text-[13px]">
                <div><span className="text-red-600">− from:</span> {locatorPreview(candidateOf(p.fromLocator))}</div>
                <div><span className="text-green-700">+ to:</span>&nbsp;&nbsp;{locatorPreview(candidateOf(p.toLocator))}</div>
              </div>
              <div className="mt-2 text-[13px] text-slate-600">
                <div>tried: {(ev.tried ?? []).join(" → ") || "—"}</div>
                <div>
                  match: {ev.matchCount ?? "?"} · verified: {ev.verified ? "yes (live unique match)" : "no"}
                  {ev.durationMs !== undefined && <> · {ev.durationMs}ms</>}
                  {ev.preview && <> · {ev.preview}</>}
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <Link to={`/tests/${testId}?focusStep=${encodeURIComponent(p.stepId)}`} className="rounded-md border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-700 hover:border-indigo-400 hover:text-indigo-700">
                  Open step in builder
                </Link>
                {p.status === "pending" && (
                  <>
                    <Button size="sm" disabled={busy === p.id} onClick={() => void decide(p.id, "approve")}>
                      {busy === p.id ? "…" : "Approve"}
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy === p.id} onClick={() => void decide(p.id, "reject")}>
                      Reject
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
