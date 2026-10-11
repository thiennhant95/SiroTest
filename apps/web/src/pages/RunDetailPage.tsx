import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, traceViewerUrl } from "../api/client";
import { ApiError, api as studioApi, apiBase, authHeaders } from "../lib/api";
import { BugReportDialog } from "../components/BugReportDialog";
import { RunTour, restartRunTour } from "../components/GuidedTour";
import { useRunChannel } from "../hooks/useRunChannel";
import { locatorPreview, type BuilderStep } from "../lib/steps";
import { sampleRun } from "../mocks/sampleRun";
import type { RunDetail, UserRole } from "../types";
import { formatDuration, formatTime, shortError } from "../lib/format";
import { EmptyState, ErrorState, RoleSwitch, RunStatusBadge, Skeleton, useToast } from "../components/ui";

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
      setError(e instanceof Error ? e.message : "Could not load the run result");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { run, loading, error, reload: load };
}

/** Fetch any artifact bytes with auth; returns an object URL (for
 *  <video> playback and trace.zip download — plain links cannot carry the
 *  Authorization header). */
function useArtifactBlob(runId: string, artifactId: string | undefined, endpoint: "image" | "download") {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!artifactId) return;
    let alive = true;
    let obj: string | null = null;
    setUrl(null);
    setFailed(false);
    void (async () => {
      try {
        const res = await fetch(
          `${apiBase}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/${endpoint}`,
          { headers: authHeaders() },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        obj = URL.createObjectURL(await res.blob());
        if (alive) setUrl(obj);
        else URL.revokeObjectURL(obj);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [runId, artifactId, endpoint]);
  return { url, failed };
}

/** Trace download (authenticated) + how to open it in Playwright's viewer. */
function TraceDownload({ runId, artifactId }: { runId: string; artifactId: string }) {
  const { url, failed } = useArtifactBlob(runId, artifactId, "download");
  if (failed) return <span className="muted">Could not load the trace.</span>;
  if (!url)
    return (
      <span className="muted small">
        Loading trace… (<code>{artifactId}.zip</code>)
      </span>
    );
  return (
    <>
      <a className="btn btn-primary" href={url} download="trace.zip">
        Download trace
      </a>
      <span className="muted small">
        Open with the native Trace Viewer: <code>npx playwright show-trace trace.zip</code> or drag the file into https://trace.playwright.dev
      </span>
    </>
  );
}

/** Run video (authenticated bytes via object URL so <video> can play it). */
function RunVideo({ runId, artifactId }: { runId: string; artifactId: string }) {
  const { url, failed } = useArtifactBlob(runId, artifactId, "download");
  if (failed) return <p className="muted small">Could not load the video.</p>;
  if (!url) return <p className="muted small">Loading video…</p>;
  return <video controls src={url} aria-label="Run video" style={{ maxWidth: "100%" }} />;
}

/** Image served by the authenticated artifact endpoint (plain <img> cannot
 *  send the Authorization header, so bytes are fetched with authHeaders and
 *  shown via an object URL). */
function AuthArtifactImage({ runId, artifactId, label }: { runId: string; artifactId: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    setSrc(null);
    setFailed(false);
    void (async () => {
      try {
        const res = await fetch(
          `${apiBase}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/image`,
          { headers: authHeaders() },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        url = URL.createObjectURL(blob);
        if (alive) setSrc(url);
        else URL.revokeObjectURL(url);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [runId, artifactId]);
  if (failed) return <p className="muted small">Could not load image {label}.</p>;
  if (!src) return <p className="muted small">Loading image {label}…</p>;
  return (
    <figure>
      <figcaption>{label}</figcaption>
      <img src={src} alt={label} style={{ maxWidth: "100%", border: "1px solid #e2e8f0", borderRadius: 4 }} />
    </figure>
  );
}

export function RunDetailPage({ runId }: { runId: string }) {  const { run, loading, error, reload } = useRun(runId);
  // Server GET /runs/:id returns artifacts as a flat array
  // [{id, type: 'result'|'trace'|'video'|'screenshot', path, mimeType, sizeBytes}].
  // (The RunDetail {traceUrl, videoUrl} object shape only exists in mocks.)
  // NOTE: hooks must stay before the loading/error early-returns (Rules of Hooks).
  const artifactList = useMemo(() => {
    const raw = (run as unknown as { artifacts?: unknown } | null)?.artifacts;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (a): a is { id: string; type: string; path: string; mimeType?: string; sizeBytes?: number } =>
        !!a && typeof a === "object" && typeof (a as { id?: unknown }).id === "string" && typeof (a as { type?: unknown }).type === "string",
    );
  }, [run]);
  const toast = useToast();
  const [role, setRole] = useState<UserRole>(
    () => (localStorage.getItem("vv-role") as UserRole) || "tester",
  );
  const [showRaw, setShowRaw] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [downloadingJUnit, setDownloadingJUnit] = useState(false);
  const [showBug, setShowBug] = useState(false);
  const [defSteps, setDefSteps] = useState<Map<string, BuilderStep>>(new Map());
  const [testName, setTestName] = useState<string | null>(null);

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
        if (typeof t.name === "string" && t.name) setTestName(t.name);
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
        toast.push("info", "Demo does not call the server (nothing is actually cancelled)");
      } else {
        await api.cancelRun(run.id);
        toast.push("success", "Cancellation requested");
        await reload();
      }
    } catch (e) {
      toast.push("error", e instanceof Error ? e.message : "Could not cancel the run");
    } finally {
      setCancelling(false);
    }
  };

  const rerun = async () => {
    if (!run) return;
    setRerunning(true);
    try {
      if (run.id === sampleRun.id) {
        toast.push("info", "Demo rerun queued (server not called)");
      } else {
        await api.rerun(run.testId, run.environmentId ?? "env_staging", run.browser);
        toast.push("success", "Rerun started — follow progress in the Runs tab");
      }
    } catch (e) {
      toast.push("error", e instanceof Error ? e.message : "Could not rerun");
    } finally {
      setRerunning(false);
    }
  };

  const downloadJUnit = async () => {
    if (!run || run.id === sampleRun.id) {
      toast.push("info", "The demo has no JUnit XML on the server");
      return;
    }
    setDownloadingJUnit(true);
    try {
      await studioApi.downloadJUnit("run", run.id);
      toast.push("success", "JUnit XML downloaded.");
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Could not download JUnit");
    } finally {
      setDownloadingJUnit(false);
    }
  };

  if (loading) {
    return (
      <section className="page" aria-label="Run detail">
        <Skeleton lines={6} label="Loading run result…" />
      </section>
    );
  }
  if (error || !run) {
    return (
      <section className="page">
        <ErrorState message={error ?? "Run not found"} onRetry={() => void reload()} />
      </section>
    );
  }

  const timelineTotal = Math.max(1, ...run.steps.map((s) => s.durationMs));
  const traceArtifact = artifactList.find((a) => a.type === "trace");
  const videoArtifact = artifactList.find((a) => a.type === "video");
  const shotArtifacts = artifactList.filter((a) => a.type === "screenshot");
  const traceUrl = run.artifacts.traceUrl;

  return (
    <section className="page" aria-label={`Run result ${run.testName || testName || run.id}`}>
      {/* Header: status + env/browser/duration */}
      <header className="run-head">
        <div>
          <p className="crumb">
            <Link to={`/tests/${run.testId}`}>← Back to test</Link>
          </p>
          <h1>{run.testName || testName || `Run ${run.id.slice(0, 8)}`}</h1>
          <p className="muted">
            Environment <strong>{run.environment}</strong> · Browser{" "}
            <strong>{run.browser}</strong> · Started {formatTime(run.startedAt)} · Duration{" "}
            <strong>{formatDuration(run.durationMs)}</strong>
          </p>
        </div>
        <div className="run-head-right">
          <RunStatusBadge status={run.status} />
          <RoleSwitch role={role} onChange={setRole} />
          <button
            type="button"
            className="btn btn-small"
            onClick={() => restartRunTour()}
            aria-label="Replay guided tour"
            title="Replay the guided tour"
          >
            ?
          </button>
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
            Run is {run.status === "queued" ? "queued" : "running"} · WS:{" "}
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
            {cancelling ? "Cancelling…" : "Cancel run"}
          </button>
        </div>
      ) : null}

      {run.errorSummary ? (
        <div className="alert alert-fail" role="alert">
          {run.errorSummary}
        </div>
      ) : run.status === "passed" ? (
        <div className="alert alert-pass" role="status">
          Test passed — all steps succeeded.
        </div>
      ) : null}

      {/* Timeline */}
      <h2>Step timeline</h2>
      {run.steps.length === 0 ? (
        <EmptyState
          title="No steps recorded"
          hint="The run may have been cancelled before it started."
        />
      ) : (
        <ol className="timeline" data-tour="run-timeline">
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
                    ? "Failed"
                    : s.status === "passed"
                      ? "Passed"
                      : s.status === "skipped"
                        ? "Skipped"
                        : "Running"}{" "}
                  · {formatDuration(s.durationMs)}
                </span>
                <span
                  className="bar"
                  aria-hidden
                  style={{ width: `${(s.durationMs / timelineTotal) * 100}%` }}
                />
              </summary>
              <div className="step-body">
                <StepTypeDetail
                  stepId={s.stepId}
                  def={s.stepId ? defSteps.get(s.stepId) : undefined}
                  testId={run.testId}
                />
                {s.error ? (
                  <>
                    <p>
                      <strong>Short error:</strong> {shortError(s.error)}
                    </p>
                    <p>
                      <strong>Locator:</strong>{" "}
                      <code>{locatorFor(s) ?? "— (not present in result/definition)"}</code>
                    </p>
                    <p>
                      <strong>Timeout:</strong>{" "}
                      {(() => {
                        const t = timeoutFor(s);
                        return t ? (
                          <>
                            <code>{t.ms}ms</code>{" "}
                            <span className="muted small">(source: {t.source})</span>
                          </>
                        ) : (
                          <span className="muted">— (runner default)</span>
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
                          {showRaw ? "Hide technical details" : "Show technical details (raw)"}
                        </button>
                        {showRaw ? (
                          <pre className="raw">{s.rawError ?? s.error}</pre>
                        ) : null}
                      </>
                    ) : (
                      <p className="muted">
                        You are viewing the concise Tester view. Switch to the "Developer" role to see the full error.
                      </p>
                    )}
                    {s.screenshotUrl ? (
                      <figure>
                        <figcaption>Failure screenshot</figcaption>
                        <img src={s.screenshotUrl} alt={`Screenshot at step ${s.name}`} />
                      </figure>
                    ) : null}
                    {s.stepId ? (
                      <Link
                        className="btn"
                        to={`/tests/${run.testId}?focusStep=${s.stepId}`}
                      >
                        Fix the failing step locator
                      </Link>
                    ) : null}
                  </>
                ) : (
                  <p className="muted">This step passed ({formatDuration(s.durationMs)}).</p>
                )}
              </div>
            </details>
          ))}
        </ol>
      )}

      {/* Artifacts */}
      <h2 data-tour="run-evidence">Evidence (screenshots / video / trace)</h2>
      {shotArtifacts.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {shotArtifacts.map((a) => (
            <AuthArtifactImage
              key={a.id}
              runId={run.id}
              artifactId={a.id}
              label={(a.path.split("/").pop() ?? a.id).replace(/\.png$/, "").replace(/^sShot$/, "Screenshot")}
            />
          ))}
        </div>
      ) : (
        <p className="muted small">This run has no screenshots (add a "screenshot" step to the test for image evidence).</p>
      )}
      <div className="row">
        {traceArtifact ? (
          <TraceDownload runId={run.id} artifactId={traceArtifact.id} />
        ) : traceUrl ? (
          <>
            <a
              className="btn btn-primary"
              href={traceViewerUrl(traceUrl)}
              target="_blank"
              rel="noreferrer"
            >
              Open trace
            </a>
            <span className="muted small">
              Open with Playwright's native Trace Viewer (not re-rendered).
            </span>
          </>
        ) : (
          <span className="muted">This run has no trace.</span>
        )}
      </div>
      {traceUrl && !traceArtifact && role === "developer" ? (
        <p className="muted small">
          Or run locally: <code>npx playwright show-trace trace.zip</code> · Original file:{" "}
          <code>{traceUrl}</code>
        </p>
      ) : null}
      {videoArtifact ? (
        <RunVideo runId={run.id} artifactId={videoArtifact.id} />
      ) : run.artifacts.videoUrl ? (
        <video controls src={run.artifacts.videoUrl} aria-label="Run video" />
      ) : (
        <p className="muted small">No video for this run.</p>
      )}

      {/* Actions */}
      <div className="row run-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={rerunning || run.status === "running"}
          onClick={() => void rerun()}
        >
          {rerunning ? "Queueing…" : "Rerun"}
        </button>
        {failedStep?.stepId ? (
          <Link className="btn" to={`/tests/${run.testId}?focusStep=${failedStep.stepId}`}>
            Fix failing step ({failedStep.name})
          </Link>
        ) : null}
        <button type="button" className="btn" onClick={() => void reload()}>
          Reload result
        </button>
        <button
          type="button"
          className="btn"
          disabled={downloadingJUnit || run.status === "running" || run.status === "queued"}
          onClick={() => void downloadJUnit()}
        >
          {downloadingJUnit ? "Downloading JUnit…" : "⬇ JUnit XML"}
        </button>
        <button
          type="button"
          className="btn"
          data-tour="run-bug"
          disabled={run.status === "running" || run.status === "queued"}
          onClick={() => setShowBug(true)}
          title="Build a Markdown bug report, download .md, or file to Jira/Backlog/Slack/Lark"
        >
          🐞 Report bug
        </button>
      </div>
      {showBug && run.projectId ? (
        <BugReportDialog runId={run.id} projectId={run.projectId} open={showBug} onClose={() => setShowBug(false)} />
      ) : null}
      <RunTour />
    </section>
  );
}

/**
 * Per-type step summary from the stored definition (generic fallback when
 * the type has no dedicated branch). Rendered for every timeline row —
 * failed or passed — so reviewers see method+URL, thresholds, file names…
 * without opening the Builder.
 */
function StepTypeDetail({ stepId, def, testId }: { stepId?: string; def?: BuilderStep; testId: string }) {
  if (!def) {
    return (
      <p className="muted small">
        {stepId ? <>Step <code>{stepId}</code> is no longer in the current definition.</> : "Unknown step definition."}
      </p>
    );
  }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (def.type) {
    case "download": {
      const url = str(def.url);
      const saveAs = str(def.saveAs);
      return (
        <p className="muted small">
          Download {url ? <>from <code>{url}</code></> : "via click + waiting for the download event"}
          {saveAs ? <> → artifact <code>{saveAs}</code> (see Evidence below)</> : null}.
        </p>
      );
    }
    case "apiRequest": {
      const method = str(def.method) || "GET";
      const url = str(def.url) || "(no URL entered)";
      const exp = typeof def.expectedStatus === "number" ? def.expectedStatus : null;
      const saveAs = str(def.saveAs);
      return (
        <p className="muted small">
          <code>{method}</code> <code>{url}</code>
          {exp !== null ? <> · expect status <code>{exp}</code></> : null}
          {saveAs ? <> · save response to <code>{saveAs}</code></> : null}.
        </p>
      );
    }
    case "visualCheck": {
      const name = str(def.name) || "(unnamed)";
      const threshold = typeof def.threshold === "number" ? def.threshold : 0.05;
      return (
        <p className="muted small">
          Compared against baseline <code>{name}</code> · threshold {(threshold * 100).toFixed(1)}% ·{" "}
          <Link to={`/tests/${testId}/visual`}>open the Visual page</Link>.
        </p>
      );
    }
    case "upload": {
      const fileId = str(def.fileId);
      return (
        <p className="muted small">
          Upload file {fileId ? <><code>{fileId}</code> (file library)</> : "(no file selected)"}.
        </p>
      );
    }
    case "newTab": {
      const url = str(def.url);
      return <p className="muted small">Open a new tab{url ? <> → <code>{url}</code></> : null}; subsequent steps use this tab.</p>;
    }
    case "closeTab":
      return <p className="muted small">Close the current tab (explicit error if it is the last tab).</p>;
    case "handleDialog": {
      const action = str(def.action) === "dismiss" ? "Dismiss" : "Accept";
      const promptText = str(def.promptText);
      return (
        <p className="muted small">
          Handle the next dialog: <code>{action}</code>
          {promptText ? <> · type <code>{promptText}</code></> : null}.
        </p>
      );
    }
    default:
      return null;
  }
}

/** Router-bound wrapper for `/runs/:id` (keeps RunDetailPage prop-based for tests/mocks). */
export function RunDetailRoute() {  const { id } = useParams();
  if (!id) {
    return (
      <section className="page">
        <p className="muted">Missing run id.</p>
        <Link to="/projects">← Back to Projects</Link>
      </section>
    );
  }
  return <RunDetailPage runId={id} />;
}
