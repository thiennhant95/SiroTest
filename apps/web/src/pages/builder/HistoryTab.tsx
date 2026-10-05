import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { sampleVersions } from "../../mocks/sampleVersions";
import type { TestVersion } from "../../types";
import { formatTime } from "../../lib/format";
import { diffSteps } from "../../lib/diff";
import { EmptyState, ErrorState, Skeleton, useToast } from "../../components/ui";
import { useConfirm } from "../../components/Confirm";

export function HistoryTab({ testId }: { testId: string }) {
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [versions, setVersions] = useState<TestVersion[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [showJson, setShowJson] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listVersions(testId);
      setVersions(list);
      setSelectedId(list[0]?.id ?? null);
    } catch {
      // Offline demo fallback.
      await new Promise((r) => setTimeout(r, 300));
      setVersions(sampleVersions);
      setSelectedId(sampleVersions[0]?.id ?? null);
    } finally {
      setLoading(false);
    }
  }, [testId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => versions?.find((v) => v.id === selectedId) ?? null,
    [versions, selectedId],
  );
  const latest = versions?.[0] ?? null;
  const diffs = useMemo(
    () =>
      selected && latest && selected.id !== latest.id
        ? diffSteps(selected.definitionJson, latest.definitionJson)
        : [],
    [selected, latest],
  );

  const restore = async () => {
    if (!selected || !latest || selected.id === latest.id) return;
    const ok = await confirm(
      `Restore to v${selected.versionNumber}? A new version will be created; old history is kept.`,
    );
    if (!ok) return;
    setRestoring(true);
    try {
      try {
        await api.restoreVersion(testId, selected.id);
      } catch {
        // Demo mode: prepend a restored copy locally.
        setVersions((prev) =>
          prev
            ? [
                {
                  ...selected,
                  id: `v-local-${Date.now()}`,
                  versionNumber: (prev[0]?.versionNumber ?? 0) + 1,
                  changeMessage: `Restored from v${selected.versionNumber}`,
                  createdAt: new Date().toISOString(),
                },
                ...prev,
              ]
            : prev,
        );
      }
      toast.push("success", `Restored v${selected.versionNumber} as a new version`);
      void load();
    } catch (e) {
      toast.push("error", e instanceof Error ? e.message : "Restore failed");
    } finally {
      setRestoring(false);
    }
  };

  if (loading) return <Skeleton lines={6} label="Loading history…" />;
  if (error || !versions)
    return <ErrorState message={error ?? "Couldn't load history"} onRetry={() => void load()} />;
  if (versions.length === 0)
    return (
      <EmptyState
        title="No saved versions yet"
        hint="Versions are created via meaningful save: autosave with a change message for each meaningful change — no version per keystroke."
      />
    );

  return (
    <div className="history" aria-label="Version history">
      <div className="history-list" role="listbox" aria-label="Version list">
        {versions.map((v) => (
          <button
            key={v.id}
            type="button"
            role="option"
            aria-selected={v.id === selectedId}
            className={`history-item${v.id === selectedId ? " active" : ""}`}
            onClick={() => {
              setSelectedId(v.id);
              setShowJson(false);
            }}
          >
            <strong>Version v{v.versionNumber}</strong>
            <span className="muted small">
              {v.createdBy} · {formatTime(v.createdAt)}
            </span>
            {v.changeMessage ? <span className="msg">{v.changeMessage}</span> : null}
          </button>
        ))}
      </div>

      <div className="history-preview">
        {selected ? (
          <>
            <h3>
              Preview version v{selected.versionNumber}{" "}
              {latest && selected.id !== latest.id ? (
                <span className="muted">vs latest v{latest.versionNumber}</span>
              ) : (
                <span className="muted">(latest)</span>
              )}
            </h3>
            {selected.id === latest?.id ? (
              <p className="muted">This is the current version — nothing to compare.</p>
            ) : diffs.length === 0 ? (
              <p className="muted">Both versions match at step level.</p>
            ) : (
              <ul>
                {diffs.map((d) => (
                  <li key={`${d.kind}-${d.id}`} className={`diff diff-${d.kind}`}>
                    {d.detail}
                  </li>
                ))}
              </ul>
            )}
            <label className="row small">
              <input
                type="checkbox"
                checked={showJson}
                onChange={(e) => setShowJson(e.target.checked)}
              />
              Show full JSON (for developers)
            </label>
            {showJson ? (
              <pre className="raw">{JSON.stringify(selected.definitionJson, null, 2)}</pre>
            ) : null}
            {selected.id !== latest?.id ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={restoring}
                onClick={() => void restore()}
              >
                {restoring ? "Restoring…" : `Restore version v${selected.versionNumber}`}
              </button>
            ) : null}
            <p className="muted small">
              Restoring always creates a new version — old history is kept.
            </p>
          </>
        ) : (
          <EmptyState title="Select a version to preview" />
        )}
      </div>
      {dialog}
    </div>
  );
}
