import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, api, type ProjectRecord, type TestRecord } from "../lib/api";
import { EmptyState, ErrorState, Skeleton } from "../components/ui";
import { ExportProjectButton, ImportSpecDialog } from "../components/ProjectTransfer";

/**
 * /projects/:id — project detail (10-ui-ux/screens.md required route).
 * Name + description, links to Tests/Environments/Settings, recent tests.
 */
export function ProjectDetailPage() {
  const { id } = useParams();
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [tests, setTests] = useState<TestRecord[] | null>(null);
  const [error, setError] = useState("");
  const [specOpen, setSpecOpen] = useState(false);

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
        setError(e instanceof ApiError ? e.message : "Could not load project");
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
        <ErrorState message="Missing project id" />
        <p className="mt-3">
          <Link to="/projects" className="text-sm text-indigo-700 hover:underline">
            ← Back to Projects
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

  const sections: Array<{ to: string; icon: string; label: string; hint: string; primary?: boolean }> = [
    { to: `/projects/${id}/tests`, icon: "🧪", label: "Tests", hint: "Author + run tests", primary: true },
    { to: `/projects/${id}/suites`, icon: "📦", label: "Suites", hint: "Group tests to run together" },
    { to: `/projects/${id}/schedules`, icon: "🕒", label: "Schedules", hint: "Run on a cron schedule" },
    { to: `/projects/${id}/analytics`, icon: "📊", label: "Analytics", hint: "Pass rate, flaky" },
    { to: `/projects/${id}/ai`, icon: "✨", label: "AI Assistant", hint: "Generate steps from a description" },
    { to: `/projects/${id}/actions`, icon: "🔁", label: "Actions", hint: "Reusable keywords" },
    { to: `/projects/${id}/profiles`, icon: "👤", label: "Profiles", hint: "Pre-authenticated logins (storage)" },
    { to: `/projects/${id}/files`, icon: "📁", label: "Files", hint: "Files for Upload steps" },
    { to: `/projects/${id}/audit`, icon: "🧾", label: "Audit", hint: "Who did what, when" },
  ];

  const tools: Array<{ to: string; label: string }> = [
    { to: "/workers", label: "Workers" },
    { to: "/plugins", label: "Plugins" },
    { to: "/settings", label: "Environments & Settings" },
  ];

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
      <nav className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Project sections">
        {sections.map((s) => (
          <Link
            key={s.to}
            to={s.to}
            className={`group rounded-lg border bg-white p-3 shadow-sm transition-colors hover:border-indigo-300 ${
              s.primary ? "border-indigo-200 ring-1 ring-indigo-100" : "border-slate-200"
            }`}
          >
            <div className="text-xl" aria-hidden>{s.icon}</div>
            <div className="mt-1 text-sm font-semibold text-slate-800 group-hover:text-indigo-700">{s.label}</div>
            <div className="text-xs text-slate-500">{s.hint}</div>
          </Link>
        ))}
      </nav>
      <div className="flex flex-wrap gap-2 text-sm">
        {tools.map((t) => (
          <Link key={t.to} to={t.to} className="text-slate-500 hover:text-slate-800 hover:underline">
            {t.label} →
          </Link>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ExportProjectButton projectId={id} projectName={project?.name} />
        <button
          type="button"
          onClick={() => setSpecOpen(true)}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
          title="Paste .spec.ts to create a test draft"
        >
          📄 Import spec
        </button>
      </div>
      <ImportSpecDialog projectId={id} open={specOpen} onClose={() => setSpecOpen(false)} />
      <section aria-label="Recent tests">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Recent tests</h2>
        {tests === null ? (
          <Skeleton className="h-12" />
        ) : tests.length === 0 ? (
          <EmptyState
            title="No tests yet"
            hint="Create your first test on the Tests page."
            action={
              <Link
                to={`/projects/${id}/tests`}
                className="text-sm text-indigo-700 hover:underline"
              >
                → Go to Tests
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
