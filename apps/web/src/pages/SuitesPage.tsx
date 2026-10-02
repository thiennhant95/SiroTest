import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, EmptyState, ErrorState, Input, Skeleton, useToast } from "../components/ui";
import { ApiError, api, type SuiteRecord } from "../lib/api";

/** /projects/:id/suites — P1 test suites (list + create). */
export function SuitesPage() {
  const { id: projectId } = useParams();
  const [suites, setSuites] = useState<SuiteRecord[] | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const toast = useToast();

  const load = async () => {
    if (!projectId) return;
    setError("");
    try {
      setSuites(await api.listSuites(projectId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tải được suites");
      setSuites([]);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <Link to={`/projects/${projectId}`} className="text-sm text-slate-500 hover:text-slate-800">
        ← Project
      </Link>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Suites</h1>
        <Link to={`/projects/${projectId}/tests`} className="text-sm text-indigo-700 hover:underline">
          Tests
        </Link>
      </div>
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!projectId || !name.trim()) return;
          try {
            const created = await api.createSuite(projectId, name.trim());
            setName("");
            toast.push("success", `Đã tạo suite “${created.name}”.`);
            void load();
          } catch (err) {
            toast.push("error", err instanceof ApiError ? err.message : "Tạo suite thất bại");
          }
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tên suite mới, vd Smoke" />
        <Button type="submit" size="md">
          + New suite
        </Button>
      </form>
      {suites === null ? (
        <div className="space-y-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : suites.length === 0 ? (
        <EmptyState title="Chưa có suite" hint="Tạo suite đầu tiên ở ô phía trên, rồi thêm tests vào." />
      ) : (
        <ul className="space-y-2">
          {suites.map((s) => (
            <li key={s.id} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div>
                <Link to={`/suites/${s.id}`} className="text-sm font-semibold text-indigo-700 hover:underline">
                  {s.name}
                </Link>
                <p className="text-xs text-slate-500">
                  {(s.tests ?? []).length} tests · <span className="font-mono text-[11px] text-slate-400">{s.id}</span>
                </p>
              </div>
              <Link to={`/suites/${s.id}`}>
                <Button size="sm" variant="outline">
                  Open suite
                </Button>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
