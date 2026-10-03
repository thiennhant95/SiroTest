import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { p2api, type HealingProposal } from "../api/p2";
import { isNotFoundError } from "../lib/api";
import { locatorPreview } from "../lib/steps";
import { EmptyState, ErrorState, Skeleton, useToast } from "../components/ui";

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
    <div style={{ padding: 24, maxWidth: 960, margin: "0 auto" }}>
      <p>
        <Link to={`/tests/${testId}`}>← Back to builder</Link>
      </p>
      <h1>Healing proposals</h1>
      <p style={{ color: "#666" }}>
        A proposal is created when a stored alternative locator succeeded where the primary
        failed. Approving rewrites the step primary (old primary demoted to alternatives) and
        mints a new test version. Nothing is ever applied automatically.
      </p>
      <div style={{ marginBottom: 12 }}>
        {(["pending", "approved", "rejected", "all"] as const).map((s) => (
          <button
            key={s}
            type="button"
            disabled={filter === s}
            onClick={() => setFilter(s)}
            style={{ marginRight: 8 }}
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
      <ul style={{ listStyle: "none", padding: 0 }}>
        {proposals.map((p) => {
          const ev = evidenceOf(p);
          return (
            <li key={p.id} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <div>
                <strong>Step <code>{p.stepId}</code></strong>
                {" · "}run <code>{p.runId}</code>
                {" · "}status <code>{p.status}</code>
              </div>
              <div style={{ marginTop: 8, fontFamily: "monospace", fontSize: 13 }}>
                <div>from: {locatorPreview(candidateOf(p.fromLocator))}</div>
                <div>to:&nbsp;&nbsp;&nbsp;{locatorPreview(candidateOf(p.toLocator))}</div>
              </div>
              <div style={{ marginTop: 8, fontSize: 13, color: "#444" }}>
                <div>tried: {(ev.tried ?? []).join(" → ") || "—"}</div>
                <div>
                  match: {ev.matchCount ?? "?"} · verified: {ev.verified ? "yes (live unique match)" : "no"}
                  {ev.durationMs !== undefined && <> · {ev.durationMs}ms</>}
                  {ev.preview && <> · {ev.preview}</>}
                </div>
              </div>
              <div style={{ marginTop: 8 }}>
                <Link to={`/tests/${testId}?focusStep=${encodeURIComponent(p.stepId)}`}>
                  Open step in builder
                </Link>
                {p.status === "pending" && (
                  <>
                    {" · "}
                    <button type="button" disabled={busy === p.id} onClick={() => void decide(p.id, "approve")}>
                      Approve
                    </button>{" "}
                    <button type="button" disabled={busy === p.id} onClick={() => void decide(p.id, "reject")}>
                      Reject
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
