import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, EmptyState, ErrorState, Skeleton, useToast } from "../components/ui";
import { ImportProjectButton } from "../components/ProjectTransfer";
import { ApiError, api, type ProjectRecord } from "../lib/api";

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null);
  const [error, setError] = useState("");
  const toast = useToast();

  const load = async () => {
    setError("");
    try {
      setProjects(await api.listProjects());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tải được projects");
      setProjects([]);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Projects</h1>
        <div className="flex items-start gap-2">
          <Link to="/settings" className="rounded-md border border-slate-300 bg-white px-3 py-1 text-sm hover:bg-slate-50">
            Settings
          </Link>
          <ImportProjectButton onImported={() => void load()} />
        <Button size="sm" variant="outline" onClick={() => toast.push("info", "Tạo project: dùng API POST /api/v1/projects (UI sẽ bổ sung).")}>
          + New project
        </Button>
        </div>
      </div>
      {projects === null ? (
        <div className="space-y-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : projects.length === 0 ? (
        <EmptyState title="Chưa có project" hint="Tạo project qua API rồi quay lại đây." />
      ) : (
        <ul className="space-y-2">
          {projects.map((p) => (
            <li key={p.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <Link to={`/projects/${p.id}`} className="text-sm font-semibold text-indigo-700 hover:underline">
                {p.name}
              </Link>
              {p.description ? <p className="text-xs text-slate-500">{p.description}</p> : null}
              <p className="font-mono text-[11px] text-slate-400">{p.id}</p>
              <p className="mt-1 text-xs">
                <Link to={`/projects/${p.id}/tests`} className="text-indigo-600 hover:underline">
                  → Tests
                </Link>
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
