import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, EmptyState, ErrorState, Input, Skeleton, useToast } from "../components/ui";
import { ApiError, api, type TestRecord } from "../lib/api";

export function ProjectTestsPage() {
  const { id: projectId } = useParams();
  const [tests, setTests] = useState<TestRecord[] | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const toast = useToast();

  const load = async () => {
    if (!projectId) return;
    setError("");
    try {
      setTests(await api.listTests(projectId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tải được tests");
      setTests([]);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <Link to="/projects" className="text-sm text-slate-500 hover:text-slate-800">
        ← Projects
      </Link>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Tests</h1>
      </div>
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!projectId || !name.trim()) return;
          try {
            const created = await api.createTest(projectId, name.trim());
            setName("");
            toast.push("success", `Đã tạo test “${created.name}”.`);
            void load();
          } catch (err) {
            toast.push("error", err instanceof ApiError ? err.message : "Tạo test thất bại");
          }
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tên test mới, vd Login flow" />
        <Button type="submit" size="md">
          + New test
        </Button>
      </form>
      {tests === null ? (
        <div className="space-y-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : tests.length === 0 ? (
        <EmptyState title="Chưa có test" hint="Tạo test đầu tiên ở ô phía trên." />
      ) : (
        <ul className="space-y-2">
          {tests.map((t) => (
            <li key={t.id} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div>
                <Link to={`/tests/${t.id}`} className="text-sm font-semibold text-indigo-700 hover:underline">
                  {t.name}
                </Link>
                <p className="font-mono text-[11px] text-slate-400">{t.id}</p>
              </div>
              <Link to={`/tests/${t.id}`}>
                <Button size="sm" variant="outline">
                  Open builder
                </Button>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
