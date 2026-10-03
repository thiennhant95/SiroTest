/**
 * P2 — Analytics (/projects/:id/analytics). NEW FILE, self-contained.
 *
 * BACKEND CONTRACT (implemented in apps/server/src/routes/analytics.ts):
 *   GET /api/v1/projects/:id/analytics/summary?days=30
 *     -> { window, totals:{total,passed,failed,cancelled}, passRate|null,
 *          avgDurationMs|null, byBrowser, errorSamples }
 *   GET /api/v1/projects/:id/analytics/flaky?runs=20
 *     -> { perTest, flaky:[{testId,testName,runs,passed,failed,flakyScore}] }
 *   GET /api/v1/projects/:id/analytics/duration?days=30&testId=
 *     -> { window, trend:[{date,runs,passed,failed,avgDurationMs|null}] }
 *   GET /api/v1/tests/:testId/history?limit=20
 *     -> { testId, testName, runs:[Run…] }   (error text already redacted)
 *
 * ROUTE CONTRACT (App.tsx maintainer wires — this file is NOT imported yet):
 *   <Route path="/projects/:id/analytics" element={<AnalyticsPage />} />
 *
 * Churn-safe: plain fetch + localStorage vv_token (same convention as
 * lib/api authHeaders), no new dependencies. Duration chart is CSS div-bars.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

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

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface Summary {
  totals: { total: number; passed: number; failed: number; cancelled: number };
  passRate: number | null;
  avgDurationMs: number | null;
  byBrowser: Record<string, { total: number; passed: number; failed: number; cancelled: number }>;
  errorSamples: (string | null)[];
}

interface FlakyRow {
  testId: string;
  testName: string;
  runs: number;
  passed: number;
  failed: number;
  flakyScore: number;
}

interface TrendPoint {
  date: string;
  runs: number;
  passed: number;
  failed: number;
  avgDurationMs: number | null;
}

interface HistoryRun {
  id: string;
  status: string;
  browser: string;
  durationMs: number | null;
  finishedAt: string | null;
  errorSummary: string | null;
}

function fmtMs(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function AnalyticsPage() {
  const { id: projectId } = useParams();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [flaky, setFlaky] = useState<FlakyRow[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [history, setHistory] = useState<HistoryRun[] | null>(null);
  const [historyTitle, setHistoryTitle] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!projectId) return;
    setError("");
    try {
      const [s, f, d] = await Promise.all([
        get<Summary>(`${API}/projects/${projectId}/analytics/summary?days=30`),
        get<{ flaky: FlakyRow[] }>(`${API}/projects/${projectId}/analytics/flaky?runs=20`),
        get<{ trend: TrendPoint[] }>(`${API}/projects/${projectId}/analytics/duration?days=30`),
      ]);
      setSummary(s);
      setFlaky(f.flaky);
      setTrend(d.trend);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tải được analytics");
    }
  }, [projectId]);

  useEffect(() => {
    setSummary(null);
    void load();
  }, [load]);

  async function openHistory(testId: string, testName: string) {
    setHistory(null);
    setHistoryTitle(testName);
    try {
      const h = await get<{ runs: HistoryRun[] }>(`${API}/tests/${testId}/history?limit=20`);
      setHistory(h.runs);
    } catch (e) {
      setHistory([]);
      setError(e instanceof Error ? e.message : "Không tải được history");
    }
  }

  const maxRuns = Math.max(1, ...trend.map((t) => t.runs));

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-6">
      <Link to={`/projects/${projectId}`} className="text-sm text-slate-500 hover:text-slate-800">
        ← Project
      </Link>
      <h1 className="text-xl font-semibold">Analytics</h1>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}

      {summary === null ? (
        <p className="text-sm text-slate-500">Đang tải…</p>
      ) : (
        <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-lg border p-3">
            <p className="text-xs text-slate-500">Pass rate (30d)</p>
            <p className="text-2xl font-semibold">
              {summary.passRate === null ? "—" : `${(summary.passRate * 100).toFixed(1)}%`}
            </p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs text-slate-500">Runs</p>
            <p className="text-2xl font-semibold">{summary.totals.total}</p>
            <p className="text-xs text-slate-500">
              {summary.totals.passed} passed · {summary.totals.failed} failed · {summary.totals.cancelled} cancelled
            </p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs text-slate-500">Avg duration</p>
            <p className="text-2xl font-semibold">{fmtMs(summary.avgDurationMs)}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs text-slate-500">By browser</p>
            {Object.entries(summary.byBrowser).map(([b, s]) => (
              <p key={b} className="text-xs">{b}: {s.passed}/{s.total} passed</p>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold">Duration trend (runs/day, CSS bars)</h2>
        {trend.length === 0 ? (
          <p className="text-xs text-slate-500">Chưa có dữ liệu 30 ngày qua.</p>
        ) : (
          <div className="space-y-1">
            {trend.map((t) => (
              <div key={t.date} className="flex items-center gap-2 text-xs">
                <span className="w-24 shrink-0 font-mono">{t.date}</span>
                <div className="h-3 flex-1 rounded bg-slate-100">
                  <div
                    className="h-3 rounded bg-indigo-500"
                    style={{ width: `${Math.max(2, (t.runs / maxRuns) * 100)}%` }}
                    title={`${t.runs} runs · avg ${fmtMs(t.avgDurationMs)}`}
                  />
                </div>
                <span className="w-40 shrink-0 text-slate-500">
                  {t.runs} runs · {t.passed}✓ {t.failed}✗ · {fmtMs(t.avgDurationMs)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Flaky tests (passed + failed trong 20 runs gần nhất)</h2>
        {flaky.length === 0 ? (
          <p className="text-xs text-slate-500">Không phát hiện flaky.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th>Test</th><th>Runs</th><th>Passed</th><th>Failed</th><th>Score</th><th />
              </tr>
            </thead>
            <tbody>
              {flaky.map((f) => (
                <tr key={f.testId} className="border-t">
                  <td>{f.testName}</td>
                  <td>{f.runs}</td>
                  <td className="text-green-700">{f.passed}</td>
                  <td className="text-red-700">{f.failed}</td>
                  <td className="font-mono">{f.flakyScore.toFixed(2)}</td>
                  <td>
                    <button
                      className="text-indigo-700 hover:underline"
                      onClick={() => void openHistory(f.testId, f.testName)}
                    >
                      History
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {history !== null ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold">History — {historyTitle}</h2>
          {history.length === 0 ? (
            <p className="text-xs text-slate-500">Không có runs.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th>Run</th><th>Status</th><th>Browser</th><th>Duration</th><th>Finished</th><th>Error</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="font-mono text-xs">
                      <Link to={`/runs/${r.id}`} className="text-indigo-700 hover:underline">{r.id.slice(0, 8)}</Link>
                    </td>
                    <td>{r.status}</td>
                    <td>{r.browser}</td>
                    <td>{fmtMs(r.durationMs)}</td>
                    <td className="text-xs">{r.finishedAt ?? "—"}</td>
                    <td className="max-w-xs truncate text-xs text-slate-500">{r.errorSummary ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}
    </main>
  );
}
