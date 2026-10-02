import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, api, type ProjectRecord, type TestRecord } from "../lib/api";
import { EmptyState, ErrorState, Skeleton } from "../components/ui";

/**
 * /projects/:id — project detail (10-ui-ux/screens.md required route).
 * Name + description, links to Tests/Environments/Settings, recent tests.
 */
export function ProjectDetailPage() {
  const { id } = useParams();
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [tests, setTests] = useState<TestRecord[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    let alive = true;
    (async () => {
      try {
        const [projects, list] = await Promise.all([
          api.listProjects(),
          api.listTests(id),
        ]);
        if (!alive) return;
        setProject(projects.find((p) => p.id === id) ?? { id, name: id });
        setTests(list.slice(0, 10));
      } catch (e) {
        if (!alive) return;
        setError(e instanceof ApiError ? e.message : "Không tải được project");
        setTests([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  if (!id) {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <ErrorState message="Thiếu id project" />
        <p className="mt-3">
          <Link to="/projects" className="text-sm text-indigo-700 hover:underline">
            ← Về Projects
          </Link>
        </p>
      </main>
    );
  }

  if (!project && !error) {
    return (
      <main className="mx-auto max-w-4xl space-y-2 p-6">
        <Skeleton className="h-10" />
        <Skeleton className="h-24" />
      </main>
    );
  }

  if (error && !project) {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <ErrorState message={error} onRetry={() => window.location.reload()} />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <Link to="/projects" className="text-sm text-slate-500 hover:text-slate-800">
        ← Projects
      </Link>
      <div>
        <h1 className="text-xl font-semibold">{project!.name}</h1>
        {project!.description ? (
          <p className="text-sm text-slate-500">{project!.description}</p>
        ) : null}
        <p className="font-mono text-[11px] text-slate-400">{project!.id}</p>
      </div>
      <nav className="flex flex-wrap gap-2" aria-label="Project sections">
        <Link
          to={`/projects/${id}/tests`}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
        >
          Tests
        </Link>
        <Link
          to={`/projects/${id}/suites`}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
        >
          Suites
        </Link>
        <Link
          to="/settings"
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
        >
          Environments &amp; Settings
        </Link>
      </nav>
      <section aria-label="Recent tests">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Tests gần đây</h2>
        {tests === null ? (
          <Skeleton className="h-12" />
        ) : tests.length === 0 ? (
          <EmptyState
            title="Chưa có test"
            hint="Tạo test đầu tiên trong trang Tests."
            action={
              <Link
                to={`/projects/${id}/tests`}
                className="text-sm text-indigo-700 hover:underline"
              >
                → Tới Tests
              </Link>
            }
          />
        ) : (
          <ul className="space-y-2">
            {tests.map((t) => (
              <li
                key={t.id}
                className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
              >
                <Link
                  to={`/tests/${t.id}`}
                  className="text-sm font-semibold text-indigo-700 hover:underline"
                >
                  {t.name}
                </Link>
                <p className="font-mono text-[11px] text-slate-400">{t.id}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
