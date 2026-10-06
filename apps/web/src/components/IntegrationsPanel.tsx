import { useEffect, useState } from "react";
import { ApiError, api, type Integration } from "../lib/api";
import { Badge, Button, Checkbox, Field, Input, Select, useToast } from "./ui";

const PROVIDERS = [
  { id: "jira", label: "Jira Cloud", config: ["site", "projectKey", "issueType"], secrets: ["email", "apiToken"], hints: { site: "https://xxx.atlassian.net", projectKey: "PROJ", issueType: "Bug" } as Record<string, string> },
  { id: "backlog", label: "Backlog", config: ["space", "projectId", "issueTypeId", "priorityId"], secrets: ["apiKey"], hints: { space: "https://xxx.backlog.com", projectId: "123", issueTypeId: "2", priorityId: "3" } as Record<string, string> },
  { id: "slack", label: "Slack", config: ["webhookUrl"], secrets: [], hints: { webhookUrl: "https://hooks.slack.com/…" } as Record<string, string> },
  { id: "lark", label: "Lark", config: ["webhookUrl"], secrets: [], hints: { webhookUrl: "https://open.larksuite.com/… (custom bot)" } as Record<string, string> },
];

/** Project integrations for bug-from-failure (Jira/Backlog/Slack/Lark). */
export function IntegrationsPanel({ projectId }: { projectId: string }) {
  const toast = useToast();
  const [rows, setRows] = useState<Integration[] | null>(null);
  const [error, setError] = useState("");
  const [provider, setProvider] = useState("jira");
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError("");
    try {
      setRows(await api.listIntegrations(projectId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't load integrations");
      setRows([]);
    }
  };

  useEffect(() => {
    setRows(null);
    setConfig({});
    setSecrets({});
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const spec = PROVIDERS.find((p) => p.id === provider)!;

  const create = async () => {
    if (!name.trim()) {
      setError("Name the integration first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.createIntegration(projectId, {
        provider,
        name: name.trim(),
        config: Object.fromEntries(Object.entries(config).filter(([, v]) => v.trim() !== "")),
        secrets: Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== "")),
      });
      setName("");
      setConfig({});
      setSecrets({});
      toast.push("success", "Integration added. Secrets are stored encrypted, never shown again.");
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Creation failed");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (row: Integration) => {
    try {
      await api.updateIntegration(row.id, { enabled: !row.enabled });
      await load();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Update failed");
    }
  };

  const remove = async (row: Integration) => {
    if (!confirm(`Delete integration "${row.name}"? Filed bugs stay where they are.`)) return;
    try {
      await api.deleteIntegration(row.id);
      await load();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Delete failed");
    }
  };

  return (
    <section aria-label="Integrations" className="space-y-3">
      <h2 className="text-sm font-semibold text-slate-700">
        Integrations (bug reports) {rows ? <Badge>{rows.length}</Badge> : null}
      </h2>
      <p className="text-[13px] text-slate-500">
        File run failures to Jira / Backlog / Slack / Lark from the run page. Credentials are encrypted at rest and never returned by the API.
      </p>
      {error ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </p>
      ) : null}
      {rows === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
          No integrations yet — add one below, then use 🐞 Report bug on any run.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
              <Badge tone={r.enabled ? "green" : "slate"}>{r.provider}</Badge>
              <strong className="text-sm">{r.name}</strong>
              {r.secretKeys.length > 0 ? (
                <span className="text-xs text-slate-500" title={`Encrypted: ${r.secretKeys.join(", ")}`}>
                  🔒 {r.secretKeys.length} secret{r.secretKeys.length > 1 ? "s" : ""}
                </span>
              ) : null}
              <span className="ml-auto flex gap-1.5">
                <Button type="button" size="sm" variant="outline" onClick={() => void toggle(r)}>
                  {r.enabled ? "Disable" : "Enable"}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => void remove(r)}>
                  Delete
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-2 gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3">
        <Field label="Provider">
          <Select value={provider} onChange={(e) => { setProvider(e.target.value); setConfig({}); setSecrets({}); }}>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Team backlog" />
        </Field>
        {spec.config.map((f) => (
          <Field key={f} label={f}>
            <Input
              value={config[f] ?? ""}
              onChange={(e) => setConfig((c) => ({ ...c, [f]: e.target.value }))}
              placeholder={spec.hints[f] ?? f}
              className="font-mono"
            />
          </Field>
        ))}
        {spec.secrets.map((f) => (
          <Field key={f} label={`${f} (secret)`}>
            <Input
              type="password"
              autoComplete="off"
              value={secrets[f] ?? ""}
              onChange={(e) => setSecrets((s) => ({ ...s, [f]: e.target.value }))}
              placeholder="stored encrypted, never shown"
            />
          </Field>
        ))}
        <label className="flex items-center gap-1.5 pb-2 text-sm text-slate-600">
          <Checkbox checked disabled /> enabled on create
        </label>
        <div className="flex justify-end">
          <Button type="button" onClick={() => void create()} disabled={busy || !name.trim()}>
            {busy ? "…" : "Add integration"}
          </Button>
        </div>
      </div>
    </section>
  );
}
