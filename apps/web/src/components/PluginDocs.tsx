import { useCallback, useEffect, useState } from "react";
import { Badge, EmptyState, ErrorState, Skeleton } from "./ui";

/**
 * P2 plugin docs component (route `/plugins`, wired in App.tsx).
 *
 * Lists loaded plugins + contributed steps from GET /api/v1/plugins and
 * documents the authoring contract (manifest shape, security model, compile
 * and run semantics). Metadata only — execute() source never reaches clients.
 */

interface PluginStepMeta {
  type: string;
  description?: string;
  schema?: {
    required?: string[];
    properties?: Record<string, { type: string; description?: string; secret?: boolean; default?: string }>;
  };
}

interface PluginMeta {
  name: string;
  version: string;
  description?: string;
  steps: PluginStepMeta[];
}

interface PluginsResponse {
  enabled: boolean;
  dirName: string;
  plugins: PluginMeta[];
}

function apiBase(): string {
  return (
    (import.meta.env?.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ??
    "/api/v1"
  );
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    const token = localStorage.getItem("vv_token");
    if (token) headers.Authorization = `Bearer ${token}`;
    else headers["x-user-id"] = "dev-user";
  } catch {
    headers["x-user-id"] = "dev-user";
  }
  return headers;
}

const AUTHORING_SAMPLE = `// plugins/kv-helpers.cjs  (trusted Dev/Admin code — review before enabling)
const { definePlugin } = require('@playwright-studio/action-sdk');

module.exports = definePlugin({
  name: 'kv-helpers',
  version: '1.0.0',
  steps: [{
    type: 'plugin:kv.fillMasked',          // globally unique, prefix plugin: required
    description: 'Fill a field from a secret variable',
    schema: {
      required: ['label', 'value'],
      properties: {
        label: { type: 'string' },
        value: { type: 'string', secret: true },  // callers MUST pass {{VARIABLE}}
      },
    },
    async execute({ page, params, stepId, env }) {
      const secret = env[params.value.replace(/[{}]/g, '').trim()] ?? params.value;
      await page.getByLabel(params.label).fill(secret);
    },
  }],
});
// Enable:  ALLOW_PLUGINS=1  +  PLUGINS_DIR=/path/to/plugins
// Reload:  POST /api/v1/plugins/reload   (Developer/Admin only)
// Use:     step { type: 'plugin:kv.fillMasked', params: { label: 'Password', value: '{{LOGIN_PW}}' } }`;

export function PluginDocs() {
  const [data, setData] = useState<PluginsResponse | null>(null);
  const [error, setError] = useState("");
  const [unsupported, setUnsupported] = useState(false);

  const load = useCallback(async () => {
    setError("");
    setUnsupported(false);
    try {
      const res = await fetch(`${apiBase()}/plugins`, { headers: authHeaders() });
      if (res.status === 404) {
        setUnsupported(true);
        setData(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as PluginsResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load plugins");
      setData(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (unsupported) {
    return (
      <section className="page" aria-label="Plugin/action SDK">
        <h1>Plugin / action SDK (P2)</h1>
        <EmptyState
          title="Backend does not support plugins yet (API 404)"
          hint="UI is ready per the GET /plugins contract. The backend needs to register pluginRoutes, then reload."
        />
        <h2>How to write a plugin</h2>
        <pre className="vv-code">{AUTHORING_SAMPLE}</pre>
      </section>
    );
  }
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!data) return <Skeleton lines={5} label="Loading plugins…" />;

  return (
    <section className="page" aria-label="Plugin/action SDK">
      <h1>Plugin / action SDK</h1>
      <p className="mt-1 text-sm text-slate-500">
        Custom step types for jobs the built-ins cannot do (SSO login, OTP, card swipe…). Disabled by default.
      </p>
      {!data.enabled && (
        <EmptyState
          title="Plugins are OFF"
          hint={`ALLOW_PLUGINS is not enabled. Set ALLOW_PLUGINS=1, review the code in ${data.dirName}, then POST /plugins/reload (Developer/Admin).`}
        />
      )}
      {data.enabled && data.plugins.length === 0 && (
        <EmptyState title="No plugins yet" hint={`Directory ${data.dirName} has no valid .js/.cjs/.mjs entries.`} />
      )}
      {data.plugins.map((p) => (
        <article key={`${p.name}@${p.version}`} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-base font-semibold">
            {p.name} <Badge tone="slate">v{p.version}</Badge>
          </h2>
          {p.description && <p className="mt-1 text-sm text-slate-600">{p.description}</p>}
          <ul className="mt-2 space-y-2">
            {p.steps.map((s) => (
              <li key={s.type} className="rounded-md bg-slate-50 p-2.5 text-sm">
                <code className="rounded bg-slate-200/70 px-1.5 py-0.5 font-mono text-xs font-semibold text-indigo-800">{s.type}</code>
                {s.description && <span className="text-slate-600"> — {s.description}</span>}
                {s.schema && (s.schema.required ?? []).length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 pl-4 font-mono text-xs text-slate-600">
                    {(s.schema.required ?? []).map((r) => (
                      <li key={r}>
                        <code className="rounded bg-white px-1 ring-1 ring-slate-200">{r}</code>
                        <span className="text-slate-500"> (required)</span>
                        {s.schema?.properties?.[r]?.secret && <strong className="text-amber-700"> — secret, use {"{{VARIABLE}}"}</strong>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </article>
      ))}

      <h2>How to write a plugin</h2>
      <pre className="vv-code">{AUTHORING_SAMPLE}</pre>
      <h2>Security model</h2>
      <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
        <li>Off by default (loads only with ALLOW_PLUGINS=1; reload is Developer/Admin only).</li>
        <li>Plugins are trusted code — NO arbitrary JS sandboxing; review before enabling.</li>
        <li>Duplicate step types across plugins → explicit load failure (no shadowing).</li>
        <li>Missing plugin → run fails with PLUGIN_NOT_FOUND (no silent skip).</li>
        <li>Secret params must be {"{{VARIABLE}}"} — checked at compile time (with registry) and at run time.</li>
      </ul>
    </section>
  );
}
