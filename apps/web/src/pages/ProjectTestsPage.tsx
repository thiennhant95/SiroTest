import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Badge, Button, EmptyState, ErrorState, Input, Select, Skeleton, useToast } from "../components/ui";
import { ExportProjectButton, ImportProjectButton, ImportSpecDialog } from "../components/ProjectTransfer";
import { ApiError, api, type TestRecord } from "../lib/api";

export function ProjectTestsPage() {
  const { id: projectId } = useParams();
  const [searchParams] = useSearchParams();
  const [tests, setTests] = useState<TestRecord[] | null>(null);
  const [tags, setTags] = useState<Array<{ tag: string; count: number }>>([]);
  // Deep-link from Builder tag badges (?tag=…).
  const [tag, setTag] = useState(() => searchParams.get("tag") ?? "");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [specOpen, setSpecOpen] = useState(false);
  const toast = useToast();

  const load = async (activeTag = tag) => {
    if (!projectId) return;
    setError("");
    try {
      const [list, tagList] = await Promise.all([
        api.listTests(projectId, activeTag || undefined),
        api.listTags(projectId),
      ]);
      setTests(list);
      setTags(tagList);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load tests");
      setTests([]);
    }
  };

  useEffect(() => {
    const initial = searchParams.get("tag") ?? "";
    setTag(initial);
    void load(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const visible = (tests ?? []).filter((t) => t.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <Link to="/projects" className="text-sm text-slate-500 hover:text-slate-800">
        ← Projects
      </Link>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Tests</h1>
        <span className="flex flex-wrap gap-3">
          <Link to={`/projects/${projectId}`} className="text-sm text-indigo-700 hover:underline">
            ← Project
          </Link>
          <Link to={`/projects/${projectId}/actions`} className="text-sm text-indigo-700 hover:underline">
            🔁 Actions
          </Link>
          <Link to={`/projects/${projectId}/profiles`} className="text-sm text-indigo-700 hover:underline">
            Profiles
          </Link>
          <Link to={`/projects/${projectId}/files`} className="text-sm text-indigo-700 hover:underline">
            Files
          </Link>
          <Link to={`/projects/${projectId}/schedules`} className="text-sm text-indigo-700 hover:underline">
            Schedules
          </Link>
          <Link to={`/projects/${projectId}/suites`} className="text-sm text-indigo-700 hover:underline">
            Suites →
          </Link>
        </span>
      </div>
      {projectId ? (
        <div className="flex flex-wrap items-center gap-2">
          <ExportProjectButton projectId={projectId} />
          <ImportProjectButton onImported={() => void load()} />
          <Button size="sm" variant="outline" onClick={() => setSpecOpen(true)} title="Paste .spec.ts to create a test draft">
            📄 Import spec
          </Button>
        </div>
      ) : null}
      {projectId ? (
        <ImportSpecDialog projectId={projectId} open={specOpen} onClose={() => setSpecOpen(false)} />
      ) : null}
      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tests by name…"
          aria-label="Search tests"
          className="max-w-xs"
        />
        <Select value={tag} onChange={(e) => { setTag(e.target.value); void load(e.target.value); }} aria-label="Filter by tag" className="max-w-xs">
          <option value="">All tags</option>
          {tags.map((t) => (
            <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>
          ))}
        </Select>
        {tag ? <Badge>{tag}</Badge> : null}
      </div>
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!projectId || !name.trim()) return;
          try {
            const created = await api.createTest(projectId, name.trim());
            setName("");
            toast.push("success", `Test "${created.name}" created.`);
            void load();
          } catch (err) {
            toast.push("error", err instanceof ApiError ? err.message : "Could not create test");
          }
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New test name, e.g. Login flow" />
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
        <EmptyState title="No tests yet" hint="Create your first test using the field above." />
      ) : visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
          No tests match "{query.trim()}". <button type="button" className="text-indigo-700 hover:underline" onClick={() => setQuery("")}>Clear search</button>
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition-colors hover:border-indigo-300">
              <div className="min-w-0">
                <Link to={`/tests/${t.id}`} className="block truncate text-sm font-semibold text-indigo-700 hover:underline">
                  {t.name}
                </Link>
                <p className="font-mono text-[11px] text-slate-400">{t.id.slice(0, 12)}…</p>
              </div>
              <Link to={`/tests/${t.id}`} className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-indigo-400 hover:text-indigo-700">
                Open builder →
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
