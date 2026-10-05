import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
  Textarea,
  useToast,
} from "../components/ui";
import { ApiError, api, isNotImplemented, type AuthProfile, type Environment } from "../lib/api";

/**
 * P1 wave 2 — Auth profiles (/projects/:id/profiles).
 * StorageState paste JSON (validated client-side); values are NEVER shown
 * after creation — list only shows a masked presence flag.
 */
export function ProfilesPage() {
  const { id: projectId } = useParams();
  const toast = useToast();
  const [profiles, setProfiles] = useState<AuthProfile[] | null>(null);
  const [error, setError] = useState("");
  const [unsupported, setUnsupported] = useState(false);
  const [envs, setEnvs] = useState<Environment[]>([]);

  const [name, setName] = useState("");
  const [envId, setEnvId] = useState("");
  const [stateJson, setStateJson] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");

  const [editing, setEditing] = useState<AuthProfile | null>(null);
  const [editName, setEditName] = useState("");
  const [editEnv, setEditEnv] = useState("");
  const [editState, setEditState] = useState("");
  const [editError, setEditError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setError("");
    setUnsupported(false);
    try {
      const [list, environments] = await Promise.all([
        api.listProfiles(projectId),
        api.listEnvironments(projectId).catch(() => [] as Environment[]),
      ]);
      setProfiles(list);
      setEnvs(environments);
      if (!envId) {
        const def = environments.find((e) => e.isDefault)?.id ?? environments[0]?.id ?? "";
        if (def) setEnvId(def);
      }
    } catch (e) {
      if (isNotImplemented(e)) {
        setUnsupported(true);
        setProfiles([]);
      } else {
        setError(e instanceof ApiError ? e.message : "Couldn't load profiles");
        setProfiles([]);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    setProfiles(null);
    void load();
  }, [load]);

  function validateStateJson(raw: string): string | null {
    if (raw.trim() === "") return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return "storageState must be a JSON object (e.g. {\"cookies\":[],\"origins\":[]}).";
      }
      return null;
    } catch {
      return "Invalid JSON — check brackets and commas.";
    }
  }

  async function create() {
    if (!projectId || !name.trim()) {
      setFormError("Enter a profile name (e.g. Staging logged-in).");
      return;
    }
    const v = validateStateJson(stateJson);
    if (v) {
      setFormError(v);
      return;
    }
    setCreating(true);
    setFormError("");
    try {
      const created = await api.createProfile(projectId, {
        name: name.trim(),
        ...(envId ? { environmentId: envId } : {}),
        ...(stateJson.trim() ? { storageStateJson: stateJson.trim() } : {}),
      });
      setProfiles((prev) => (prev ? [created, ...prev] : [created]));
      setName("");
      setStateJson("");
      toast.push("success", `Created profile “${created.name}”. Login state masked.`);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Profile creation failed";
      setFormError(msg);
      toast.push("error", msg);
    } finally {
      setCreating(false);
    }
  }

  function openEdit(p: AuthProfile) {
    setEditing(p);
    setEditName(p.name);
    setEditEnv(p.environmentId ?? "");
    setEditState("");
    setEditError("");
  }

  async function saveEdit() {
    if (!editing) return;
    if (!editName.trim()) {
      setEditError("Name must not be empty.");
      return;
    }
    const v = validateStateJson(editState);
    if (v) {
      setEditError(v);
      return;
    }
    setSaving(true);
    setEditError("");
    try {
      const saved = await api.updateProfile(editing.id, {
        name: editName.trim(),
        environmentId: editEnv || null,
        ...(editState.trim() ? { storageStateJson: editState.trim() } : {}),
      });
      setProfiles((prev) => prev?.map((x) => (x.id === saved.id ? saved : x)) ?? [saved]);
      setEditing(null);
      toast.push("success", `Saved profile “${saved.name}”.`);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Save failed";
      setEditError(msg);
    } finally {
      setSaving(false);
    }
  }

  async function remove(p: AuthProfile) {
    if (!window.confirm(`Delete profile “${p.name}”? Runs that used it keep their history.`)) return;
    try {
      await api.deleteProfile(p.id);
      setProfiles((prev) => prev?.filter((x) => x.id !== p.id) ?? []);
      toast.push("success", "Deleted profile.");
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Deletion failed");
    }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <Link to={`/projects/${projectId}`} className="text-sm text-slate-500 hover:text-slate-800">
        ← Project
      </Link>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Auth profiles</h1>
        <span className="flex gap-3 text-sm">
          <Link to={`/projects/${projectId}/tests`} className="text-indigo-700 hover:underline">Tests</Link>
          <Link to={`/projects/${projectId}/files`} className="text-indigo-700 hover:underline">Files</Link>
          <Link to={`/projects/${projectId}/schedules`} className="text-indigo-700 hover:underline">Schedules</Link>
        </span>
      </div>
      <p className="text-sm text-slate-500">
        Shared login state (storageState) — paste JSON from Playwright and attach an environment.
        Values are <strong>never shown again</strong> after saving (masked).
      </p>

      {unsupported ? (
        <EmptyState
          title="Backend profiles not supported (API 404)"
          hint="UI is ready per contract GET/POST /projects/:id/profiles. Waiting on P1 wave 2 backend — reload later."
        />
      ) : profiles === null ? (
        <div className="space-y-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          <fieldset className="space-y-2 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <legend className="px-1 text-sm font-semibold text-slate-700">New profile</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Field label="Profile name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Staging logged-in" />
              </Field>
              <Field label="Environment (optional)">
                <Select value={envId} onChange={(e) => setEnvId(e.target.value)}>
                  <option value="">— Unassigned —</option>
                  {envs.map((e) => (
                    <option key={e.id} value={e.id}>{e.name}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="storageState JSON (paste from Playwright)" hint='{"cookies":[],"origins":[]} — blank means the profile has no login yet.'>
              <Textarea
                aria-label="storageState JSON"
                value={stateJson}
                onChange={(e) => setStateJson(e.target.value)}
                rows={4}
                spellCheck={false}
                placeholder='{"cookies":[],"origins":[]}'
              />
            </Field>
            {formError ? (
              <p role="alert" className="text-xs text-red-700">{formError}</p>
            ) : null}
            <Button size="sm" disabled={creating} onClick={() => void create()}>
              {creating ? "Creating…" : "+ New profile"}
            </Button>
          </fieldset>

          {profiles.length === 0 ? (
            <EmptyState title="No profiles yet" hint="Create your first profile above." />
          ) : (
            <DataTable<AuthProfile>
              caption="Auth profiles — storageState always masked"
              emptyText="No profiles yet."
              rows={profiles}
              columns={[
                { key: "name", header: "Profile", render: (r) => <span className="font-medium">{r.name}</span> },
                {
                  key: "environmentId",
                  header: "Environment",
                  render: (r) => r.environmentName ?? r.environmentId ?? "—",
                },
                {
                  key: "hasStorageState",
                  header: "Login",
                  render: (r) =>
                    r.hasStorageState ? <Badge tone="green">saved login (masked)</Badge> : <Badge>no saved login</Badge>,
                },
                {
                  key: "id",
                  header: "Actions",
                  render: (r) => (
                    <span className="flex gap-1">
                      <Button size="sm" variant="ghost" className="text-indigo-700 hover:text-indigo-900" onClick={() => openEdit(r)}>Edit</Button>
                      <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-800" onClick={() => void remove(r)}>Delete</Button>
                    </span>
                  ),
                },
              ]}
            />
          )}
        </>
      )}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing ? `Edit profile “${editing.name}”` : "Edit profile"}>
        <div className="space-y-3">
          <Field label="Profile name">
            <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
          </Field>
          <Field label="Environment">
            <Select value={editEnv} onChange={(e) => setEditEnv(e.target.value)}>
              <option value="">— Unassigned —</option>
              {envs.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Replace storageState (blank = keep current)" hint="Paste new JSON to replace the login; the old value is never shown.">
            <Textarea
              aria-label="New storageState"
              value={editState}
              onChange={(e) => setEditState(e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder='{"cookies":[],"origins":[]}'
            />
          </Field>
          {editError ? (
            <p role="alert" className="text-xs text-red-700">{editError}</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button size="sm" disabled={saving} onClick={() => void saveEdit()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </Dialog>
    </main>
  );
}
