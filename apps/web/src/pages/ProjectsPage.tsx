import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Dialog, EmptyState, ErrorState, Field, Input, Skeleton, Textarea, useToast } from "../components/ui";
import { ImportProjectButton } from "../components/ProjectTransfer";
import { ApiError, api, type ProjectRecord } from "../lib/api";

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const toast = useToast();

  const load = async () => {
    setError("");
    try {
      setProjects(await api.listProjects());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load projects");
      setProjects([]);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCreate = () => {
    setName("");
    setDescription("");
    setBaseUrl("");
    setFormError("");
    setCreating(true);
  };

  const submitCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError("Enter a project name.");
      return;
    }
    if (baseUrl.trim()) {
      try {
        const u = new URL(baseUrl.trim());
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad proto");
      } catch {
        setFormError("Base URL must be a valid http(s) URL (or left empty).");
        return;
      }
    }
    setSaving(true);
    setFormError("");
    try {
      const created = await api.createProject({
        name: trimmed,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      });
      setCreating(false);
      toast.push("success", `Project "${created.name}" created.`);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not create project.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Projects</h1>
        <div className="flex items-center gap-2">
          <Link to="/settings">
            <Button size="sm" variant="outline">Settings</Button>
          </Link>
          <ImportProjectButton onImported={() => void load()} />
        <Button size="sm" variant="outline" onClick={openCreate}>
          + New project
        </Button>
        </div>
      </div>
      <Dialog open={creating} onClose={() => setCreating(false)} title="New project">
        <form onSubmit={(e) => void submitCreate(e)} className="space-y-4 px-4 py-4">
          {formError && (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {formError}
            </p>
          )}
          <Field label="Project name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="E.g.: LienHoa E-commerce" autoFocus />
          </Field>
          <Field label="Description (optional)">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Pilot staging admin…" />
          </Field>
          <Field label="Base URL (optional)" hint="http(s). Used as the default target when running tests.">
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://test.aloa.asia" inputMode="url" />
          </Field>
          <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Creating…" : "Create project"}</Button>
          </div>
        </form>
      </Dialog>
      {projects === null ? (
        <div className="space-y-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : projects.length === 0 ? (
        <EmptyState title="No projects yet" hint="Click + New project to create your first project." />
      ) : (
        <ul className="space-y-2">
          {projects.map((p) => (
            <li key={p.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition-colors hover:border-indigo-300">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Link to={`/projects/${p.id}`} className="text-sm font-semibold text-indigo-700 hover:underline">
                    {p.name}
                  </Link>
                  {p.description ? <p className="truncate text-xs text-slate-500">{p.description}</p> : null}
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-slate-400">
                    <span>{p.id.slice(0, 12)}…</span>
                    {p.baseUrl ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">{p.baseUrl}</span> : null}
                  </p>
                </div>
                <Link to={`/projects/${p.id}/tests`} className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-indigo-400 hover:text-indigo-700">
                  Tests →
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
