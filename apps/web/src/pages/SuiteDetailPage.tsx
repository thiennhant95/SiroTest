import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Badge, Button, EmptyState, ErrorState, Input, Select, Skeleton, useToast } from "../components/ui";
import { RunModal } from "../components/RunModal";
import { ApiError, api, type Environment, type SuiteExecution, type SuiteMember, type SuiteRecord, type TestRecord } from "../lib/api";

/**
 * /suites/:sid — P1 suite detail: member management (add / remove / reorder
 * via up-down + full PUT replace), Run suite (reused RunModal in suite mode),
 * and the execution history grouped by suiteRunId.
 */
export function SuiteDetailPage() {
  const { sid } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [suite, setSuite] = useState<SuiteRecord | null>(null);
  const [tests, setTests] = useState<TestRecord[]>([]);
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [envId, setEnvId] = useState("");
  const [executions, setExecutions] = useState<SuiteExecution[] | null>(null);
  const [error, setError] = useState("");
  const [addId, setAddId] = useState("");
  const [showRun, setShowRun] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!sid) return;
    setError("");
    try {
      const s = await api.getSuite(sid);
      setSuite(s);
      const [all, environments, runs] = await Promise.all([
        api.listTests(s.projectId),
        api.listEnvironments(s.projectId),
        api.listSuiteRuns(sid),
      ]);
      setTests(all);
      setEnvs(environments);
      setEnvId((prev) => {
        if (prev && environments.some((e) => e.id === prev)) return prev;
        return environments.find((e) => e.isDefault)?.id ?? environments[0]?.id ?? "";
      });
      setExecutions(runs);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't load suite");
    }
  }, [sid]);

  useEffect(() => {
    void load();
  }, [load]);

  const members: SuiteMember[] = (suite?.tests ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
  const memberIds = new Set(members.map((m) => m.testId));
  const candidates = tests.filter((t) => !memberIds.has(t.id));

  const reorder = async (testIds: string[]) => {
    if (!sid) return;
    setBusy(true);
    try {
      const next = await api.reorderSuiteMembers(sid, testIds);
      setSuite((s) => (s ? { ...s, tests: next } : s));
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Reorder failed");
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, delta: -1 | 1) => {
    const ids = members.map((m) => m.testId);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    const [moved] = ids.splice(index, 1);
    ids.splice(j, 0, moved!);
    void reorder(ids);
  };

  if (!suite && !error) {
    return (
      <main className="mx-auto max-w-4xl space-y-2 p-6">
        <Skeleton className="h-10" />
        <Skeleton className="h-24" />
      </main>
    );
  }
  if (error && !suite) {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <ErrorState message={error} onRetry={load} />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl space-y-5 p-6">
      <Link to={`/projects/${suite!.projectId}/suites`} className="text-sm text-slate-500 hover:text-slate-800">
        ← Suites
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{suite!.name}</h1>
        <Badge>{members.length} tests</Badge>
        <span className="ml-auto flex gap-2">
          <Button size="sm" disabled={members.length === 0 || !envId} onClick={() => setShowRun(true)} title={members.length === 0 ? "Add tests to the suite first" : !envId ? "No environment yet" : "Run suite"}>
            ▶ Run suite
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              if (!sid || !window.confirm(`Delete suite “${suite!.name}”? Run history is kept.`)) return;
              try {
                await api.deleteSuite(sid);
                toast.push("success", "Deleted suite.");
                nav(`/projects/${suite!.projectId}/suites`);
              } catch (e) {
                toast.push("error", e instanceof ApiError ? e.message : "Couldn't delete suite");
              }
            }}
          >
            Delete
          </Button>
        </span>
      </div>

      <section aria-label="Members" className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-700">Tests in suite (run order)</h2>
        {members.length === 0 ? (
          <EmptyState title="Suite has no tests yet" hint="Add a test in the field below." />
        ) : (
          <ol className="space-y-2">
            {members.map((m, i) => (
              <li key={m.testId} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                <span className="w-6 text-xs text-slate-400">{i + 1}.</span>
                <Link to={`/tests/${m.testId}`} className="flex-1 text-sm font-medium text-indigo-700 hover:underline">
                  {m.test?.name ?? m.testId}
                </Link>
                <Button size="sm" variant="outline" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${m.test?.name ?? m.testId} up`}>
                  ↑
                </Button>
                <Button size="sm" variant="outline" disabled={busy || i === members.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${m.test?.name ?? m.testId} down`}>
                  ↓
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    if (!sid) return;
                    try {
                      await api.removeSuiteMember(sid, m.testId);
                      setSuite((s) => (s ? { ...s, tests: (s.tests ?? []).filter((x) => x.testId !== m.testId) } : s));
                    } catch (e) {
                      toast.push("error", e instanceof ApiError ? e.message : "Couldn't remove member");
                    }
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ol>
        )}
        <form
          className="flex gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!sid || !addId) return;
            try {
              const added = await api.addSuiteMember(sid, addId);
              setAddId("");
              setSuite((s) => (s ? { ...s, tests: [...(s.tests ?? []), { ...added, test: tests.find((t) => t.id === added.testId) ? { id: added.testId, name: tests.find((t) => t.id === added.testId)!.name } : undefined }] } : s));
              toast.push("success", "Added test to suite.");
            } catch (err) {
              toast.push("error", err instanceof ApiError ? err.message : "Couldn't add test");
            }
          }}
        >
          <Select value={addId} onChange={(e) => setAddId(e.target.value)} className="flex-1" aria-label="Test to add">
            <option value="">Select a test to add…</option>
            {candidates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </Select>
          <Button type="submit" size="md" disabled={!addId}>
            + Add
          </Button>
        </form>
      </section>

      <section aria-label="Executions" className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-700">Runs</h2>
        {executions === null ? (
          <Skeleton className="h-12" />
        ) : executions.length === 0 ? (
          <EmptyState title="No runs yet" hint="Click Run suite to start the first run." />
        ) : (
          <ul className="space-y-2">
            {executions.map((x) => (
              <li key={x.suiteRunId} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-sm">
                <Badge tone={x.status === "failed" ? "red" : x.status === "passed" ? "green" : "slate"}>{x.status}</Badge>
                <Link to={`/suite-runs/${x.suiteRunId}`} className="font-mono text-xs text-indigo-700 hover:underline">
                  {x.suiteRunId}
                </Link>
                <span className="text-xs text-slate-500">
                  {x.counts.passed} passed · {x.counts.failed} failed · {x.counts.running} running · {x.counts.cancelled} cancelled · {x.counts.total} total
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Add by id" className="rounded-lg border border-slate-200 bg-white p-3">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Quick add by test ID</h2>
        <QuickAdd suiteId={sid!} onAdded={load} />
      </section>

      {showRun && sid ? (
        <RunModal
          testId={members[0]?.testId ?? ""}
          suiteId={sid}
          envs={envs}
          envId={envId || null}
          onClose={() => setShowRun(false)}
          onStarted={() => setShowRun(false)}
          onSuiteStarted={(suiteRunId) => {
            setShowRun(false);
            toast.push("success", `Created suite run ${suiteRunId}.`);
            nav(`/suite-runs/${suiteRunId}`);
          }}
        />
      ) : null}
    </main>
  );
}

function QuickAdd({ suiteId, onAdded }: { suiteId: string; onAdded: () => void }) {
  const [id, setId] = useState("");
  const toast = useToast();
  return (
    <form
      className="flex gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!id.trim()) return;
        try {
          await api.addSuiteMember(suiteId, id.trim());
          setId("");
          toast.push("success", "Added test to suite.");
          onAdded();
        } catch (err) {
          toast.push("error", err instanceof ApiError ? err.message : "Couldn't add test");
        }
      }}
    >
      <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="test id…" className="font-mono" />
      <Button type="submit" size="sm" variant="outline">
        Add by id
      </Button>
    </form>
  );
}
