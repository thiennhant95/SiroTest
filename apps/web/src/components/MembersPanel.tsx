import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type ProjectMember } from "../lib/api";
import { Badge, Button, Field, Input, Select, useToast } from "./ui";

/**
 * Project members (Settings → Members).
 *
 * Owner-only writes; everyone with access can read. Owner role is shown but
 * cannot be changed here (it comes from project creation). Adding an email
 * that has not signed up returns a clear 404 message.
 */
export function MembersPanel({ projectId }: { projectId: string }) {
  const toast = useToast();
  const [rows, setRows] = useState<ProjectMember[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("editor");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api.listMembers(projectId));
      setErr(null);
    } catch (e) {
      setRows([]);
      setErr(e instanceof ApiError ? e.message : "Could not load members");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    try {
      await api.addMember(projectId, email.trim(), role);
      setEmail("");
      toast.push("success", "Member added");
      await load();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Could not add member");
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(userId: string, next: "viewer" | "editor") {
    setBusy(true);
    try {
      await api.updateMemberRole(projectId, userId, next);
      toast.push("success", "Role updated");
      await load();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Could not update role");
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string, who: string) {
    setBusy(true);
    try {
      await api.removeMember(projectId, userId);
      toast.push("success", `${who} removed`);
      await load();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Could not remove member");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Members" className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="mb-1 text-sm font-semibold text-slate-700">
        Members <Badge>{rows?.length ?? 0}</Badge>
      </h2>
      <p className="mb-3 text-xs text-slate-500">
        Add a teammate by the email they signed up with. Owners manage access; editors author and run tests; viewers read and run.
      </p>

      {err ? <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{err}</p> : null}

      <form onSubmit={add} className="mb-4 flex flex-wrap items-end gap-2">
        <Field label="Email">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@company.com"
            className="w-64"
          />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as "viewer" | "editor")}>
            <option value="editor">editor</option>
            <option value="viewer">viewer</option>
          </Select>
        </Field>
        <Button type="submit" disabled={busy || !email.trim()}>
          Add member
        </Button>
      </form>

      {rows === null ? (
        <p className="text-xs text-slate-500">Loading members…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-slate-500">No members yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-slate-800">{m.email}</p>
                {m.name ? <p className="truncate text-xs text-slate-500">{m.name}</p> : null}
              </div>
              {m.role === "owner" ? (
                <Badge tone="indigo">owner</Badge>
              ) : (
                <Select
                  aria-label={`Role for ${m.email}`}
                  value={m.role}
                  disabled={busy}
                  onChange={(e) => void changeRole(m.userId, e.target.value as "viewer" | "editor")}
                >
                  <option value="editor">editor</option>
                  <option value="viewer">viewer</option>
                </Select>
              )}
              {m.role === "owner" ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void remove(m.userId, m.email)}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
