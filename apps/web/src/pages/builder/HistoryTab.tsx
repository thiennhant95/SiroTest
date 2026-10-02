import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { sampleVersions } from "../../mocks/sampleVersions";
import type { TestVersion } from "../../types";
import { formatTime } from "../../lib/format";
import { diffSteps } from "../../lib/diff";
import { EmptyState, ErrorState, Skeleton } from "../../components/ui";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/Confirm";

export function HistoryTab({ testId }: { testId: string }) {
  const { notify } = useToast();
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
      `Khôi phục về bản v${selected.versionNumber}? Hệ thống sẽ tạo bản mới, không xóa lịch sử cũ.`,
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
                  changeMessage: `Khôi phục từ bản v${selected.versionNumber}`,
                  createdAt: new Date().toISOString(),
                },
                ...prev,
              ]
            : prev,
        );
      }
      notify(`Đã khôi phục bản v${selected.versionNumber} thành bản mới`);
      void load();
    } catch (e) {
      notify(e instanceof Error ? e.message : "Khôi phục thất bại", "err");
    } finally {
      setRestoring(false);
    }
  };

  if (loading) return <Skeleton lines={6} label="Đang tải lịch sử…" />;
  if (error || !versions)
    return <ErrorState message={error ?? "Không tải được lịch sử"} onRetry={() => void load()} />;
  if (versions.length === 0)
    return (
      <EmptyState
        title="Chưa có bản lưu nào"
        hint="Bản lưu được tạo qua meaningful save: autosave kèm changeMessage cho mỗi thay đổi có ý nghĩa — hệ thống không tạo bản cho từng phím gõ."
      />
    );

  return (
    <div className="history" aria-label="Lịch sử bản lưu">
      <div className="history-list" role="listbox" aria-label="Danh sách bản lưu">
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
            <strong>Bản v{v.versionNumber}</strong>
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
              Xem trước bản v{selected.versionNumber}{" "}
              {latest && selected.id !== latest.id ? (
                <span className="muted">so với bản mới nhất v{latest.versionNumber}</span>
              ) : (
                <span className="muted">(bản mới nhất)</span>
              )}
            </h3>
            {selected.id === latest?.id ? (
              <p className="muted">Đây là bản hiện tại — không có gì để so sánh.</p>
            ) : diffs.length === 0 ? (
              <p className="muted">Hai bản giống nhau ở cấp bước.</p>
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
              Hiện JSON đầy đủ (cho Developer)
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
                {restoring ? "Đang khôi phục…" : `Khôi phục bản v${selected.versionNumber}`}
              </button>
            ) : null}
            <p className="muted small">
              Khôi phục luôn tạo bản mới — lịch sử cũ được giữ nguyên.
            </p>
          </>
        ) : (
          <EmptyState title="Chọn một bản để xem trước" />
        )}
      </div>
      {dialog}
    </div>
  );
}
