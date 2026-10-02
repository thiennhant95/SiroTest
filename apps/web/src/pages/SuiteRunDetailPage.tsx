import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge, Button, DataTable, EmptyState, ErrorState, Skeleton, useToast } from "../components/ui";
import { ApiError, api, type SuiteRunDetail } from "../lib/api";

/**
 * /suite-runs/:suiteRunId — P1 suite execution detail: per-test status table
 * (final status + retry counts + per-attempt rows), cancel, and JUnit download.
 */
export function SuiteRunDetailPage() {
  const { suiteRunId } = useParams();
  const toast = useToast();
  const [detail, setDetail] = useState<SuiteRunDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!suiteRunId) return;
    try {
      setDetail(await api.getSuiteRun(suiteRunId));
      setError("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tải được suite run");
    }
  }, [suiteRunId]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => {
      setDetail((d) => {
        if (d && ["passed", "failed", "cancelled"].includes(d.status)) {
          window.clearInterval(t);
          return d;
        }
        void load();
        return d;
      });
    }, 3000);
    return () => window.clearInterval(t);
  }, [load]);

  if (!detail && !error) {
    return (
      <main className="mx-auto max-w-5xl space-y-2 p-6">
        <Skeleton className="h-10" />
        <Skeleton className="h-24" />
      </main>
    );
  }
  if (error && !detail) {
    return (
      <main className="mx-auto max-w-5xl p-6">
        <ErrorState message={error} onRetry={load} />
      </main>
    );
  }

  const live = detail!.status === "queued" || detail!.status === "running";
  const flat = detail!.tests.flatMap((t) =>
    t.attempts.map((a) => ({ ...a, id: a.runId, testId: t.testId, testName: t.testName, retryCount: t.retryCount })),
  );

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-6">
      <p>
        {detail!.suite ? (
          <Link to={`/suites/${detail!.suite.id}`} className="text-sm text-slate-500 hover:text-slate-800">
            ← {detail!.suite.name}
          </Link>
        ) : (
          <Link to="/projects" className="text-sm text-slate-500 hover:text-slate-800">
            ← Projects
          </Link>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="font-mono text-lg font-semibold">{detail!.suiteRunId}</h1>
        <Badge tone={detail!.status === "failed" ? "red" : detail!.status === "passed" ? "green" : "slate"}>
          {detail!.status}
        </Badge>
        <span className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              if (!suiteRunId) return;
              setBusy(true);
              try {
                await api.downloadJUnit("suite-run", suiteRunId);
                toast.push("success", "Đã tải JUnit XML.");
              } catch (e) {
                toast.push("error", e instanceof ApiError ? e.message : "Tải JUnit thất bại");
              } finally {
                setBusy(false);
              }
            }}
          >
            ⬇ JUnit XML
          </Button>
          {live ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                if (!suiteRunId) return;
                setBusy(true);
                try {
                  await api.cancelSuiteRun(suiteRunId);
                  toast.push("success", "Đã gửi yêu cầu hủy suite run.");
                  await load();
                } catch (e) {
                  toast.push("error", e instanceof ApiError ? e.message : "Hủy thất bại");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Hủy suite run
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Tải lại
          </Button>
        </span>
      </div>

      {flat.length === 0 ? (
        <EmptyState title="Chưa có attempt nào" hint="Suite sequential đang xếp hàng — đợi giây lát rồi tải lại." />
      ) : (
        <DataTable
          caption="Kết quả từng test trong suite run"
          emptyText="Chưa có attempt."
          rows={flat}
          columns={[
            {
              key: "status",
              header: "Status",
              render: (r) => (
                <Badge tone={r.status === "failed" ? "red" : r.status === "passed" ? "green" : "slate"}>
                  {r.status}
                </Badge>
              ),
            },
            {
              key: "testName",
              header: "Test",
              render: (r) => (
                <Link to={`/tests/${r.testId}`} className="font-medium text-indigo-700 hover:underline">
                  {r.testName}
                </Link>
              ),
            },
            { key: "attempt", header: "Attempt" },
            {
              key: "retryCount",
              header: "Retries",
              render: (r) => (r.retryCount > 0 ? `${r.retryCount}x` : "—"),
            },
            { key: "browser", header: "Browser" },
            { key: "trigger", header: "Trigger" },
            {
              key: "runId",
              header: "Run",
              render: (r) => (
                <Link to={`/runs/${r.runId}`} className="font-mono text-xs text-indigo-700 hover:underline">
                  {r.runId.slice(0, 12)}…
                </Link>
              ),
            },
          ]}
        />
      )}
      {flat.some((r) => r.errorSummary) ? (
        <section aria-label="Failures" className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-700">Lỗi (attempt cuối mỗi test)</h2>
          {detail!.tests
            .filter((t) => t.attempts[t.attempts.length - 1]?.status === "failed")
            .map((t) => (
              <div key={t.testId} className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
                <p className="font-medium">{t.testName}</p>
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs text-red-800">
                  {t.attempts[t.attempts.length - 1]?.errorSummary ?? "failed"}
                </pre>
              </div>
            ))}
        </section>
      ) : null}
    </main>
  );
}
