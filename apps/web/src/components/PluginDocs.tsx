import { useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorState, Skeleton } from "./ui";

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
  dir: string;
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
      setError(e instanceof Error ? e.message : "Không tải được plugins");
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
          title="Backend chưa hỗ trợ plugins (API 404)"
          hint="UI đã sẵn sàng theo contract GET /plugins. Cần backend đăng ký pluginRoutes rồi reload."
        />
        <h2>Cách viết plugin</h2>
        <pre className="vv-code">{AUTHORING_SAMPLE}</pre>
      </section>
    );
  }
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!data) return <Skeleton lines={5} label="Đang tải plugins…" />;

  return (
    <section className="page" aria-label="Plugin/action SDK">
      <h1>Plugin / action SDK (P2)</h1>
      {!data.enabled && (
        <EmptyState
          title="Plugins đang TẮT"
          hint={`ALLOW_PLUGINS chưa bật. Đặt ALLOW_PLUGINS=1, review code trong ${data.dir}, rồi POST /plugins/reload (Developer/Admin).`}
        />
      )}
      {data.enabled && data.plugins.length === 0 && (
        <EmptyState title="Chưa có plugin" hint={`Thư mục ${data.dir} chưa có entry .js/.cjs/.mjs hợp lệ.`} />
      )}
      {data.plugins.map((p) => (
        <article key={`${p.name}@${p.version}`}>
          <h2>
            {p.name} <span className="muted">v{p.version}</span>
          </h2>
          {p.description && <p>{p.description}</p>}
          <ul>
            {p.steps.map((s) => (
              <li key={s.type}>
                <code>{s.type}</code>
                {s.description && <span> — {s.description}</span>}
                {s.schema && (
                  <ul>
                    {(s.schema.required ?? []).map((r) => (
                      <li key={r}>
                        <code>{r}</code> (required)
                        {s.schema?.properties?.[r]?.secret && <strong> — secret, dùng {"{{VARIABLE}}"}</strong>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </article>
      ))}

      <h2>Cách viết plugin</h2>
      <pre className="vv-code">{AUTHORING_SAMPLE}</pre>
      <h2>Mô hình bảo mật</h2>
      <ul>
        <li>Mặc định TẮT (ALLOW_PLUGINS=1 mới load; reload chỉ Developer/Admin).</li>
        <li>Plugin là code tin cậy — KHÔNG sandbox JS tùy ý; review trước khi bật.</li>
        <li>Step type trùng giữa plugins → load fail rõ ràng (không shadow).</li>
        <li>Plugin không thấy → run fail với PLUGIN_NOT_FOUND (không silent skip).</li>
        <li>Secret params phải là {"{{VARIABLE}}"} — kiểm tra lúc compile (có registry) và lúc chạy.</li>
      </ul>
    </section>
  );
}
