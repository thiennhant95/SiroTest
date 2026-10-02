import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, traceViewerUrl } from "../api/client";
import { useRunChannel } from "../hooks/useRunChannel";
import { locatorPreview, type BuilderStep } from "../lib/steps";
import { sampleRun } from "../mocks/sampleRun";
import type { RunDetail, UserRole } from "../types";
import { formatDuration, formatTime, shortError } from "../lib/format";
import { EmptyState, ErrorState, RoleSwitch, RunStatusBadge, Skeleton } from "../components/ui";
import { useToast } from "../components/Toast";

function useRun(runId: string) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Demo id works offline; real id hits GET /api/v1/runs/:id.
      if (runId === sampleRun.id || runId === "demo") {
        await new Promise((r) => setTimeout(r, 350));
        setRun(sampleRun);
      } else {
        setRun(await api.getRun(runId));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tải được kết quả chạy");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { run, loading, error, reload: load };
}

export function RunDetailPage({ runId }: { runId: string }) {  const { run, loading, error, reload } = useRun(runId);
  const { notify } = useToast();
  const [role, setRole] = useState<UserRole>(
    () => (localStorage.getItem("vv-role") as UserRole) || "tester",
  );
  const [showRaw, setShowRaw] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [defSteps, setDefSteps] = useState<Map<string, BuilderStep>>(new Map());

  // Live WS subscription (08-api/websocket-events.md): informational only —
  // DB (useRun above) stays authoritative; terminal events trigger refetch.
  const isLive = !!run && (run.status === "queued" || run.status === "running");
  const channel = useRunChannel(isLive ? runId : null);
  const channelStatus = channel.run?.status;
  useEffect(() => {
    if (channelStatus === "passed" || channelStatus === "failed" || channelStatus === "cancelled") {
      void reload();
    }
  }, [channelStatus, reload]);

  // Step definition lookup for flow-C locator rows (fallback when result
  // JSON carries no locator expression itself).
  useEffect(() => {
    if (!run || run.id === sampleRun.id) return;
    let alive = true;
    api
      .getTest(run.testId)
      .then((t) => {
        if (!alive) return;
        const raw = t.definitionJson as { steps?: BuilderStep[] } | null;
        const steps = Array.isArray(raw?.steps) ? raw!.steps! : [];
        setDefSteps(new Map(steps.map((s) => [s.id, s])));
      })
      .catch(() => {
        if (alive) setDefSteps(new Map());
      });
    return () => {
      alive = false;
    };
  }, [run]);

  useEffect(() => {
    localStorage.setItem("vv-role", role);
  }, [role]);

  const failedStep = useMemo(
    () => run?.steps.find((s) => s.status === "failed") ?? null,
    [run],
  );

  const locatorFor = useCallback(
    (s: { stepId?: string; target?: unknown; locatorExpression?: string }) => {
      if (s.locatorExpression) return s.locatorExpression;
      if (s.target) return locatorPreview(s.target);
      const def = s.stepId ? defSteps.get(s.stepId) : undefined;
      const target = (def as { target?: unknown } | undefined)?.target;
      return target ? locatorPreview(target) : null;
    },
    [defSteps],
  );

  const timeoutFor = useCallback(
    (s: { stepId?: string; timeoutMs?: number; timeoutSource?: string }) => {
      if (typeof s.timeoutMs === "number") {
        return { ms: s.timeoutMs, source: s.timeoutSource ?? "result" };
      }
      const def = s.stepId ? defSteps.get(s.stepId) : undefined;
      if (typeof def?.timeoutMs === "number") return { ms: def.timeoutMs, source: "step" };
      return null;
    },
    [defSteps],
  );

  const cancel = async () => {
    if (!run) return;
    setCancelling(true);
    try {
      if (run.id === sampleRun.id) {
        notify("Bản demo không gọi server (không hủy thật)");
      } else {
        await api.cancelRun(run.id);
        notify("Đã gửi yêu cầu hủy run");
        await reload();
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : "Hủy run thất bại", "err");
    } finally {
      setCancelling(false);
    }
  };

  const rerun = async () => {
    if (!run) return;
    setRerunning(true);
    try {
      if (run.id === sampleRun.id) {
        notify("Đã xếp hàng chạy lại bản demo (không gọi server)");
      } else {
        await api.rerun(run.testId, run.environmentId ?? "env_staging", run.browser);
        notify("Đã chạy lại — xem tiến trình ở tab Lượt chạy");
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : "Chạy lại thất bại", "err");
    } finally {
      setRerunning(false);
    }
  };

  if (loading) {
    return (
      <section className="page" aria-label="Chi tiết lượt chạy">
        <Skeleton lines={6} label="Đang tải kết quả chạy…" />
      </section>
    );
  }
  if (error || !run) {
    return (
      <section className="page">
        <ErrorState message={error ?? "Không tìm thấy lượt chạy"} onRetry={() => void reload()} />
      </section>
    );
  }

  const timelineTotal = Math.max(1, ...run.steps.map((s) => s.durationMs));
  const traceUrl = run.artifacts.traceUrl;

  return (
    <section className="page" aria-label={`Kết quả chạy ${run.testName}`}>
      {/* Header: status + env/browser/duration */}
      <header className="run-head">
        <div>
          <p className="crumb">
            <Link to={`/tests/${run.testId}`}>← Về bài kiểm thử</Link>
          </p>
          <h1>{run.testName}</h1>
          <p className="muted">
            Môi trường <strong>{run.environment}</strong> · Trình duyệt{" "}
            <strong>{run.browser}</strong> · Bắt đầu {formatTime(run.startedAt)} · Kéo dài{" "}
            <strong>{formatDuration(run.durationMs)}</strong>
          </p>
        </div>
        <div className="run-head-right">
          <RunStatusBadge status={run.status} />
          <RoleSwitch role={role} onChange={setRole} />
        </div>
      </header>

      {isLive ? (
        <div className="alert" role="status" data-testid="run-live-banner">
          <div
            aria-hidden
            data-testid="run-progress-bar"
            style={{
              height: 6,
              borderRadius: 4,
              background: "#e5e7eb",
              overflow: "hidden",
              marginBottom: 8,
            }}
          >
            <div
              style={{
                width: run.steps.length
                  ? `${Math.round((run.steps.filter((s) => ["passed", "failed", "skipped"].includes(s.status)).length / run.steps.length) * 100)}%`
                  : "15%",
                height: "100%",
                background: "#4f46e5",
                transition: "width .3s",
              }}
            />
          </div>
          <p className="muted small">
            Run đang {run.status === "queued" ? "xếp hàng" : "chạy"} · WS:{" "}
            {channel.connected ? "connected" : "reconnecting…"}
            {channel.error ? ` · ${channel.error}` : null}
          </p>
          <button
            type="button"
            className="btn"
            data-testid="cancel-btn"
            disabled={cancelling}
            onClick={() => void cancel()}
          >
            {cancelling ? "Đang hủy…" : "Hủy run"}
          </button>
        </div>
      ) : null}

      {run.errorSummary ? (
        <div className="alert alert-fail" role="alert">
          {run.errorSummary}
        </div>
      ) : run.status === "passed" ? (
        <div className="alert alert-pass" role="status">
          Bài kiểm thử chạy đạt — mọi bước đều ổn.
        </div>
      ) : null}

      {/* Timeline */}
      <h2>Diễn biến từng bước</h2>
      {run.steps.length === 0 ? (
        <EmptyState
          title="Chưa có bước nào được ghi nhận"
          hint="Lượt chạy có thể bị hủy trước khi bắt đầu."
        />
      ) : (
        <ol className="timeline">
          {run.steps.map((s) => (
            <details
              key={s.id}
              className={`step step-${s.status}`}
              open={s.status === "failed"}
            >
              <summary>
                <span className="step-name">{s.name}</span>
                <span className="step-meta">
                  {s.status === "failed"
                    ? "Lỗi"
                    : s.status === "passed"
                      ? "Xong"
                      : s.status === "skipped"
                        ? "Bỏ qua"
                        : "Đang chạy"}{" "}
                  · {formatDuration(s.durationMs)}
                </span>
                <span
                  className="bar"
                  aria-hidden
                  style={{ width: `${(s.durationMs / timelineTotal) * 100}%` }}
                />
              </summary>
              <div className="step-body">
                {s.error ? (
                  <>
                    <p>
                      <strong>Lỗi gọn:</strong> {shortError(s.error)}
                    </p>
                    <p>
                      <strong>Locator:</strong>{" "}
                      <code>{locatorFor(s) ?? "— (không có trong result/definition)"}</code>
                    </p>
                    <p>
                      <strong>Timeout:</strong>{" "}
                      {(() => {
                        const t = timeoutFor(s);
                        return t ? (
                          <>
                            <code>{t.ms}ms</code>{" "}
                            <span className="muted small">(nguồn: {t.source})</span>
                          </>
                        ) : (
                          <span className="muted">— (mặc định runner)</span>
                        );
                      })()}
                    </p>
                    {role === "developer" ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => setShowRaw((v) => !v)}
                          aria-expanded={showRaw}
                        >
                          {showRaw ? "Ẩn chi tiết kỹ thuật" : "Xem chi tiết kỹ thuật (raw)"}
                        </button>
                        {showRaw ? (
                          <pre className="raw">{s.rawError ?? s.error}</pre>
                        ) : null}
                      </>
                    ) : (
                      <p className="muted">
                        Bạn đang xem gọn cho Tester. Chuyển vai trò “Developer” để xem mã lỗi đầy đủ.
                      </p>
                    )}
                    {s.screenshotUrl ? (
                      <figure>
                        <figcaption>Ảnh chụp lúc lỗi</figcaption>
                        <img src={s.screenshotUrl} alt={`Ảnh chụp tại bước ${s.name}`} />
                      </figure>
                    ) : null}
                    {s.stepId ? (
                      <Link
                        className="btn"
                        to={`/tests/${run.testId}?focusStep=${s.stepId}`}
                      >
                        Sửa định danh bước lỗi
                      </Link>
                    ) : null}
                  </>
                ) : (
                  <p className="muted">Bước này ổn ({formatDuration(s.durationMs)}).</p>
                )}
              </div>
            </details>
          ))}
        </ol>
      )}

      {/* Artifacts */}
      <h2>Bằng chứng (ảnh / video / trace)</h2>
      <div className="row">
        {traceUrl ? (
          <>
            <a
              className="btn btn-primary"
              href={traceViewerUrl(traceUrl)}
              target="_blank"
              rel="noreferrer"
            >
              Mở Trace
            </a>
            <span className="muted small">
              Mở bằng Trace Viewer gốc của Playwright (không dựng lại).
            </span>
          </>
        ) : (
          <span className="muted">Lượt chạy này không có trace.</span>
        )}
      </div>
      {traceUrl && role === "developer" ? (
        <p className="muted small">
          Hoặc chạy local: <code>npx playwright show-trace trace.zip</code> · File gốc:{" "}
          <code>{traceUrl}</code>
        </p>
      ) : null}
      {run.artifacts.videoUrl ? (
        <video controls src={run.artifacts.videoUrl} aria-label="Video lượt chạy" />
      ) : (
        <p className="muted small">Không có video cho lượt chạy này.</p>
      )}

      {/* Actions */}
      <div className="row run-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={rerunning || run.status === "running"}
          onClick={() => void rerun()}
        >
          {rerunning ? "Đang xếp hàng…" : "Chạy lại"}
        </button>
        {failedStep?.stepId ? (
          <Link className="btn" to={`/tests/${run.testId}?focusStep=${failedStep.stepId}`}>
            Sửa bước lỗi ({failedStep.name})
          </Link>
        ) : null}
        <button type="button" className="btn" onClick={() => void reload()}>
          Tải lại kết quả
        </button>
      </div>
    </section>
  );
}

/** Router-bound wrapper for `/runs/:id` (keeps RunDetailPage prop-based for tests/mocks). */
export function RunDetailRoute() {
  const { id } = useParams();
  if (!id) {
    return (
      <section className="page">
        <p className="muted">Thiếu id lượt chạy.</p>
        <Link to="/projects">← Về Projects</Link>
      </section>
    );
  }
  return <RunDetailPage runId={id} />;
}
