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
        setError(e instanceof ApiError ? e.message : "Không tải được profiles");
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
        return "storageState phải là JSON object (vd {\"cookies\":[],\"origins\":[]}).";
      }
      return null;
    } catch {
      return "JSON chưa hợp lệ — kiểm tra dấu ngoặc/phẩy.";
    }
  }

  async function create() {
    if (!projectId || !name.trim()) {
      setFormError("Nhập tên profile (vd Staging logged-in).");
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
      toast.push("success", `Đã tạo profile “${created.name}”. Trạng thái đăng nhập đã che (masked).`);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Tạo profile thất bại";
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
      setEditError("Tên không được trống.");
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
      toast.push("success", `Đã lưu profile “${saved.name}”.`);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Lưu thất bại";
      setEditError(msg);
    } finally {
      setSaving(false);
    }
  }

  async function remove(p: AuthProfile) {
    if (!window.confirm(`Xóa profile “${p.name}”? Các run đã dùng profile này giữ nguyên lịch sử.`)) return;
    try {
      await api.deleteProfile(p.id);
      setProfiles((prev) => prev?.filter((x) => x.id !== p.id) ?? []);
      toast.push("success", "Đã xóa profile.");
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Xóa thất bại");
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
        Trạng thái đăng nhập dùng chung (storageState) — dán JSON từ Playwright, gắn environment.
        Giá trị <strong>không bao giờ hiện lại</strong> sau khi lưu (masked).
      </p>

      {unsupported ? (
        <EmptyState
          title="Backend chưa hỗ trợ profiles (API 404)"
          hint="UI đã sẵn sàng theo contract GET/POST /projects/:id/profiles. Đợi backend P1 wave 2 rồi reload."
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
          <fieldset className="space-y-2 rounded-lg border border-slate-200 bg-white p-4">
            <legend className="px-1 text-sm font-semibold text-slate-700">New profile</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Field label="Tên profile">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="vd Staging logged-in" />
              </Field>
              <Field label="Environment (tùy chọn)">
                <Select value={envId} onChange={(e) => setEnvId(e.target.value)}>
                  <option value="">— Không gắn —</option>
                  {envs.map((e) => (
                    <option key={e.id} value={e.id}>{e.name}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="storageState JSON (dán từ Playwright)" hint='{"cookies":[],"origins":[]} — để trống = profile chưa có login.'>
              <textarea
                aria-label="storageState JSON"
                value={stateJson}
                onChange={(e) => setStateJson(e.target.value)}
                rows={4}
                spellCheck={false}
                placeholder='{"cookies":[],"origins":[]}'
                className="w-full rounded-md border border-slate-300 p-2 font-mono text-xs"
              />
            </Field>
            {formError ? (
              <p role="alert" className="text-xs text-red-700">{formError}</p>
            ) : null}
            <Button size="sm" disabled={creating} onClick={() => void create()}>
              {creating ? "Đang tạo…" : "+ New profile"}
            </Button>
          </fieldset>

          {profiles.length === 0 ? (
            <EmptyState title="Chưa có profile" hint="Tạo profile đầu tiên ở ô phía trên." />
          ) : (
            <DataTable<AuthProfile>
              caption="Auth profiles — storageState luôn masked"
              emptyText="Chưa có profile."
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
                  header: "Thao tác",
                  render: (r) => (
                    <span className="flex gap-2 text-xs">
                      <button className="text-indigo-700 hover:underline" onClick={() => openEdit(r)}>Sửa</button>
                      <button className="text-red-600 hover:underline" onClick={() => void remove(r)}>Xóa</button>
                    </span>
                  ),
                },
              ]}
            />
          )}
        </>
      )}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing ? `Sửa profile “${editing.name}”` : "Sửa profile"}>
        <div className="space-y-3">
          <Field label="Tên profile">
            <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
          </Field>
          <Field label="Environment">
            <Select value={editEnv} onChange={(e) => setEditEnv(e.target.value)}>
              <option value="">— Không gắn —</option>
              {envs.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Thay storageState (để trống = giữ nguyên)" hint="Dán JSON mới để thay login; giá trị cũ không hiện.">
            <textarea
              aria-label="storageState mới"
              value={editState}
              onChange={(e) => setEditState(e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder='{"cookies":[],"origins":[]}'
              className="w-full rounded-md border border-slate-300 p-2 font-mono text-xs"
            />
          </Field>
          {editError ? (
            <p role="alert" className="text-xs text-red-700">{editError}</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(null)}>Hủy</Button>
            <Button size="sm" disabled={saving} onClick={() => void saveEdit()}>
              {saving ? "Đang lưu…" : "Save"}
            </Button>
          </div>
        </div>
      </Dialog>
    </main>
  );
}
