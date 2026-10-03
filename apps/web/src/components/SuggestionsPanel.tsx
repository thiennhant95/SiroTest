import { useCallback, useEffect, useState } from "react";
import { p2api, type SuggestedAssertion } from "../api/p2";
import { isNotFoundError } from "../lib/api";
import { EmptyState, ErrorState, Skeleton, useToast } from "./ui";

/**
 * P2 — suggested assertions from observed page (deterministic rules, NO AI).
 * Wired into BuilderPage bottom tab "Suggest".
 *
 * The panel fetches rule-based suggestions (fill → assertValue, click →
 * assertVisible of the next target, goto → assertURL, …), shows them as a
 * checklist, and inserts the checked ones via the explicit apply endpoint
 * (which versions the definition like PATCH /tests/:id).
 */
export interface SuggestionsPanelProps {
  testId: string;
  sessionId?: string;
  onApplied?: (result: { versionNumber: number; stepCount: number }) => void;
}

export function SuggestionsPanel({ testId, sessionId, onApplied }: SuggestionsPanelProps) {
  const toast = useToast();
  const [suggestions, setSuggestions] = useState<SuggestedAssertion[]>([]);
  const [source, setSource] = useState<string>("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUnsupported(false);
    setNotice(null);
    try {
      const res = await p2api.fetchSuggestions(testId, sessionId ? { sessionId } : {});
      setSuggestions(res.suggestions);
      setSource(res.source);
      setChecked(new Set(res.suggestions.map((s) => s.id)));
    } catch (e) {
      if (isNotFoundError(e)) {
        setUnsupported(true);
        setSuggestions([]);
      } else {
        setError(e instanceof Error ? e.message : "Failed to load suggestions");
      }
    } finally {
      setLoading(false);
    }
  }, [testId, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function apply() {
    const ids = suggestions.map((s) => s.id).filter((id) => checked.has(id));
    if (ids.length === 0) {
      setError("Select at least one suggestion to insert");
      return;
    }
    setApplying(true);
    setError(null);
    try {
      const res = await p2api.applySuggestions(testId, { suggestionIds: ids });
      const msg = `Inserted ${res.applied.length} assertion step(s) — now at version ${res.versionNumber}.`;
      setNotice(msg);
      toast.push("success", msg);
      onApplied?.({ versionNumber: res.versionNumber, stepCount: res.stepCount });
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Apply failed";
      setError(msg);
      toast.push("error", msg);
    } finally {
      setApplying(false);
    }
  }

  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>Suggested assertions</strong>
        <button type="button" disabled={loading} onClick={() => void refresh()}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {source && <p style={{ fontSize: 12, color: "#666" }}>mined from: {source} (deterministic rules, no AI)</p>}
      {loading ? <Skeleton className="h-10" /> : null}
      {unsupported ? (
        <EmptyState
          title="Backend chưa hỗ trợ suggestions (API 404)"
          hint="UI đã sẵn sàng theo contract POST /tests/:id/suggestions. Đợi backend P2 rồi bấm Refresh."
        />
      ) : error ? (
        <ErrorState message={error} onRetry={refresh} />
      ) : null}
      {notice && <p style={{ color: "green" }}>{notice}</p>}
      {!loading && !unsupported && !error && suggestions.length === 0 && (
        <EmptyState title="Không có gợi ý cho steps hiện tại" hint="Thêm fill/click/goto rồi bấm Refresh." />
      )}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {suggestions.map((s) => (
          <li key={s.id} style={{ marginBottom: 8 }}>
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <input type="checkbox" checked={checked.has(s.id)} onChange={() => toggle(s.id)} />
              <span>
                <code>{s.kind}</code> after <code>{s.afterStepId}</code>
                {s.masked && <em> (secret masked)</em>}
                <br />
                <span style={{ fontSize: 13, color: "#444" }}>{s.reason}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {suggestions.length > 0 && (
        <button type="button" disabled={applying || checked.size === 0} onClick={() => void apply()}>
          {applying ? "Inserting…" : `Insert selected (${checked.size})`}
        </button>
      )}
    </div>
  );
}
