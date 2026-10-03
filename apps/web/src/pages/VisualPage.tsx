import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import { isNotFoundError } from "../lib/api";
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Skeleton,
  useToast,
} from "../components/ui";

/**
 * P2 visual regression page (`/tests/:id/visual`, wired in App.tsx).
 *
 * - Baselines list (metadata + baseline image, never server paths).
 * - Side-by-side baseline / actual / diff for a selected run (artifact images
 *   load with the auth token via object URLs — <img> cannot send headers).
 * - Threshold editor hint (thresholds live in the test definition — edit them
 *   in the Builder; this page shows the effective value per visualCheck step).
 * - Promote (artifact -> baseline) + capture-run trigger (updateBaselines).
 * - History: recent runs of this test.
 */

interface BaselineMeta {
  name: string;
  width: number | null;
  height: number | null;
  createdAt: string;
  updatedAt: string;
}

interface VisualStepInfo {
  stepId: string;
  name: string;
  threshold: number;
}

interface RunArtifact {
  id: string;
  type: string;
  path: string;
  mimeType?: string | null;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    const token = localStorage.getItem("vv_token");
    if (token) headers.Authorization = `Bearer ${token}`;
    else headers["x-user-id"] = "dev-user";
  } catch {
    headers["x-user-id"] = "dev-user";
  }
  return headers;
}

function apiBase(): string {
  return (
    (import.meta.env?.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ??
    "/api/v1"
  );
}

function useAuthedImage(url: string | null): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!url) {
      setObjectUrl(null);
      return;
    }
    let alive = true;
    let current: string | null = null;
    fetch(url, { headers: authHeaders() })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        if (!alive) return;
        current = URL.createObjectURL(blob);
        setObjectUrl(current);
      })
      .catch(() => {
        if (alive) setObjectUrl(null);
      });
    return () => {
      alive = false;
      if (current) URL.revokeObjectURL(current);
    };
  }, [url]);
  return objectUrl;
}

function BaselineImage({ testId, name }: { testId: string; name: string }) {
  const src = useAuthedImage(
    `${apiBase()}/tests/${encodeURIComponent(testId)}/baselines/${encodeURIComponent(name)}/image`,
  );
  if (!src) return <div className="vv-img-fallback">Không tải được baseline</div>;
  return <img src={src} alt={`Baseline ${name}`} className="vv-shot" />;
}

function ArtifactImage({ runId, artifactId, label }: { runId: string; artifactId: string; label: string }) {
  const src = useAuthedImage(
    `${apiBase()}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/image`,
  );
  if (!src) return <div className="vv-img-fallback">Không có ảnh</div>;
  return <img src={src} alt={label} className="vv-shot" />;
}

export function VisualPage() {
  const { id: testId } = useParams();
  const toast = useToast();
  const [baselines, setBaselines] = useState<BaselineMeta[] | null>(null);
  const [steps, setSteps] = useState<VisualStepInfo[]>([]);
  const [error, setError] = useState("");
  const [unsupported, setUnsupported] = useState(false);
  const [runId, setRunId] = useState("");
  const [promoteName, setPromoteName] = useState("");
  const [envId, setEnvId] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [runArtifacts, setRunArtifacts] = useState<RunArtifact[] | null>(null);
  const [compareName, setCompareName] = useState("");

  const load = useCallback(async () => {
    if (!testId) return;
    setError("");
    setUnsupported(false);
    try {
      const res = await fetch(`${apiBase()}/tests/${testId}/baselines`, { headers: authHeaders() });
      if (res.status === 404) {
        setUnsupported(true);
        setBaselines([]);
        return;
      }
      if (!res.ok) throw new Error(`Baselines HTTP ${res.status}`);
      setBaselines((await res.json()) as BaselineMeta[]);
      const test = await api.getTest(testId);
      const def = test.definitionJson as { steps?: Array<Record<string, unknown>> } | null;
      const found: VisualStepInfo[] = [];
      for (const s of def?.steps ?? []) {
        if (s.type === "visualCheck" && typeof s.name === "string") {
          found.push({
            stepId: String(s.id ?? ""),
            name: s.name,
            threshold: typeof s.threshold === "number" ? s.threshold : 0.05,
          });
        }
      }
      setSteps(found);
    } catch (e) {
      if (isNotFoundError(e)) {
        setUnsupported(true);
        setBaselines([]);
      } else {
        setError(e instanceof Error ? e.message : "Không tải được baselines");
        setBaselines([]);
      }
    }
  }, [testId]);

  useEffect(() => {
    setBaselines(null);
    void load();
  }, [load]);

  async function loadRunArtifacts() {
    if (!runId.trim()) return;
    setNotice("");
    setRunArtifacts(null);
    try {
      const run = await api.getRun(runId.trim());
      setRunArtifacts((run.artifacts ?? []) as unknown as RunArtifact[]);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Không tải được run");
    }
  }

  async function promote() {
    if (!testId || !promoteName.trim() || !runId.trim()) return;
    setBusy(true);
    setNotice("");
    try {
      const res = await fetch(`${apiBase()}/tests/${testId}/baselines`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ name: promoteName.trim(), runId: runId.trim() }),
      });
      if (!res.ok) throw new Error(`Promote HTTP ${res.status}: ${await res.text()}`);
      const msg = `Đã promote “${promoteName.trim()}” thành baseline.`;
      setNotice(msg);
      toast.push("success", msg);
      setPromoteName("");
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Promote thất bại";
      setNotice(msg);
      toast.push("error", msg);
    } finally {
      setBusy(false);
    }
  }

  async function triggerCapture() {
    if (!testId || !envId.trim()) return;
    setBusy(true);
    setNotice("");
    try {
      const res = await fetch(`${apiBase()}/tests/${testId}/visual-runs`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ environmentId: envId.trim(), updateBaselines: true }),
      });
      if (!res.ok) throw new Error(`Visual run HTTP ${res.status}: ${await res.text()}`);
      const run = (await res.json()) as { id: string };
      setRunId(run.id);
      const msg = `Đã xếp hàng capture run ${run.id} — promote từng ảnh sau khi run PASS.`;
      setNotice(msg);
      toast.push("success", msg);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Trigger run thất bại";
      setNotice(msg);
      toast.push("error", msg);
    } finally {
      setBusy(false);
    }
  }

  async function removeBaseline(name: string) {
    if (!testId || !window.confirm(`Xóa baseline “${name}”?`)) return;
    setNotice("");
    try {
      const res = await fetch(
        `${apiBase()}/tests/${testId}/baselines/${encodeURIComponent(name)}`,
        { method: "DELETE", headers: authHeaders() },
      );
      if (!res.ok) throw new Error(`Delete HTTP ${res.status}`);
      const msg = `Đã xóa baseline “${name}”.`;
      setNotice(msg);
      toast.push("success", msg);
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Xóa thất bại";
      setNotice(msg);
      toast.push("error", msg);
    }
  }

  const visualArtifacts = (runArtifacts ?? []).filter(
    (a) => a.mimeType?.startsWith("image/") && /visual-.*\.png$/.test(a.path),
  );
  const fileFor = (kind: "actual" | "diff") =>
    visualArtifacts.find((a) =>
      kind === "actual"
        ? a.path === `runs/${runId.trim()}/screenshots/visual-${compareName}.png`
        : a.path === `runs/${runId.trim()}/screenshots/visual-${compareName}.diff.png`,
    );

  if (baselines === null) {
    return (
      <section className="page" aria-label="Visual baselines">
        <Skeleton lines={6} label="Đang tải baselines…" />
      </section>
    );
  }

  return (
    <section className="page" aria-label="Visual baselines">
      <nav>
        <Link to={testId ? `/tests/${testId}` : "/projects"}>← Về Builder</Link>
      </nav>
      <h1>Visual regression</h1>
      {unsupported ? (
        <EmptyState
          title="Backend chưa hỗ trợ visual baselines (API 404)"
          hint="UI đã sẵn sàng theo contract GET /tests/:id/baselines. Đợi backend P2 rồi reload."
        />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : null}
      {notice && <p role="status">{notice}</p>}

      <h2>visualCheck steps (threshold từ definition)</h2>
      {steps.length === 0 ? (
        <EmptyState
          title="Chưa có visualCheck step"
          hint="Thêm step visualCheck trong Builder (cần allowlist patch ở server — xem tài liệu P2)."
        />
      ) : (
        <ul>
          {steps.map((s) => (
            <li key={s.stepId}>
              <code>{s.name}</code> — threshold {(s.threshold * 100).toFixed(2)}%{" "}
              <span className="muted">(sửa trong Builder)</span>
            </li>
          ))}
        </ul>
      )}

      <h2>Baselines ({baselines.length})</h2>
      {baselines.length === 0 ? (
        <EmptyState title="Chưa có baseline" hint="Chạy capture (updateBaselines) rồi promote ảnh actual." />
      ) : (
        <ul className="vv-cards">
          {baselines.map((b) => (
            <li key={b.name} className="vv-card">
              <strong>{b.name}</strong>{" "}
              <span className="muted">
                {b.width}×{b.height} · cập nhật {new Date(b.updatedAt).toLocaleString()}
              </span>
              {testId && <BaselineImage testId={testId} name={b.name} />}
              <div>
                <Button size="sm" variant="outline" onClick={() => void removeBaseline(b.name)}>
                  Xóa
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2>So sánh baseline / actual / diff</h2>
      <Field label="Run ID">
        <Input value={runId} onChange={(e) => setRunId(e.target.value)} placeholder="run_…" />
      </Field>
      <div>
        <Button size="sm" onClick={() => void loadRunArtifacts()}>
          Tải artifacts của run
        </Button>
      </div>
      {visualArtifacts.length > 0 && (
        <>
          <Field label="Baseline cần so sánh">
            <Input
              value={compareName}
              onChange={(e) => setCompareName(e.target.value)}
              placeholder="hero"
            />
          </Field>
          {compareName && (
            <div className="vv-compare">
              <figure>
                <figcaption>Baseline</figcaption>
                {testId && <BaselineImage testId={testId} name={compareName} />}
              </figure>
              <figure>
                <figcaption>Actual</figcaption>
                {fileFor("actual") ? (
                  <ArtifactImage runId={runId.trim()} artifactId={fileFor("actual")!.id} label="Actual" />
                ) : (
                  <div className="vv-img-fallback">Không có actual</div>
                )}
              </figure>
              <figure>
                <figcaption>Diff (điểm khác màu đỏ)</figcaption>
                {fileFor("diff") ? (
                  <ArtifactImage runId={runId.trim()} artifactId={fileFor("diff")!.id} label="Diff" />
                ) : (
                  <div className="vv-img-fallback">Không có diff (run PASS hoặc chưa so sánh)</div>
                )}
              </figure>
            </div>
          )}
        </>
      )}

      <h2>Promote actual → baseline</h2>
      <Field label="Baseline name">
        <Input value={promoteName} onChange={(e) => setPromoteName(e.target.value)} placeholder="hero" />
      </Field>
      <div>
        <Button size="sm" disabled={busy} onClick={() => void promote()}>
          Promote từ run trên
        </Button>
      </div>

      <h2>Capture baselines (updateBaselines)</h2>
      <Field label="Environment ID">
        <Input value={envId} onChange={(e) => setEnvId(e.target.value)} placeholder="env_…" />
      </Field>
      <div>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void triggerCapture()}>
          Chạy capture (visual steps luôn PASS)
        </Button>
      </div>
    </section>
  );
}
