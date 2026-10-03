import { useEffect, useMemo, useState } from "react";
import { Badge, Dialog, Field, Input } from "./ui";
import { STEP_CATALOG, STEP_GROUPS, isPluginStepType, pluginCatalogEntries, searchCatalog, type StepMeta } from "../lib/steps";

interface PluginListResponse {
  enabled: boolean;
  plugins: Array<{ name: string; steps: Array<{ type: string; description?: string }> }>;
}

function pluginsApiBase(): string {
  return (
    (import.meta.env?.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ??
    "/api/v1"
  );
}

function pluginsAuthHeaders(): Record<string, string> {
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

/** Add-step palette grouped Nav/Interaction/Wait/Assertion/Utility + human search. */
export function AddStepPalette({
  open,
  onClose,
  onAdd,
  insertLabel,
  excludeTypes,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (type: string) => void;
  insertLabel?: string;
  /** Hide step types (e.g. action bodies reject nested `callAction`). */
  excludeTypes?: string[];
}) {
  const [q, setQ] = useState("");
  const [pluginSteps, setPluginSteps] = useState<StepMeta[]>([]);
  const [pluginsEnabled, setPluginsEnabled] = useState<boolean | null>(null);
  const [customType, setCustomType] = useState("");
  const [customError, setCustomError] = useState("");

  // Dynamic plugin entries from GET /plugins; silent when backend lacks it.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch(`${pluginsApiBase()}/plugins`, { headers: pluginsAuthHeaders() })
      .then((res) => {
        if (!alive) return;
        if (res.status === 404) {
          setPluginSteps([]);
          setPluginsEnabled(null);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (res.json() as Promise<PluginListResponse>).then((data) => {
          if (!alive) return;
          setPluginsEnabled(data.enabled);
          setPluginSteps(data.enabled ? pluginCatalogEntries(data.plugins) : []);
        });
      })
      .catch(() => {
        if (alive) {
          setPluginSteps([]);
          setPluginsEnabled(null);
        }
      });
    return () => {
      alive = false;
    };
  }, [open ]);

  const results = useMemo(() => {
    const all = [...searchCatalog(q), ...pluginSteps.filter((m) => {
      const query = q.trim().toLowerCase();
      if (!query) return true;
      return [m.label, m.type, m.description, ...m.keywords].join(" ").toLowerCase().includes(query);
    })];
    // The bare "plugin:" catalog entry is a fallback marker, not a real type —
    // real plugin steps come from GET /plugins or the manual input below.
    const real = all.filter((m) => m.type !== "plugin:");
    if (!excludeTypes || excludeTypes.length === 0) return real;
    const hidden = new Set(excludeTypes);
    return real.filter((m) => !hidden.has(m.type));
  }, [q, pluginSteps, excludeTypes]);

  const pluginResults = useMemo(() => results.filter((m) => isPluginStepType(m.type)), [results]);
  const coreResults = useMemo(() => results.filter((m) => !isPluginStepType(m.type)), [results]);

  const addCustom = () => {
    const t = customType.trim();
    if (!isPluginStepType(t)) {
      setCustomError("Type phải có prefix “plugin:” (vd plugin:kv.fillMasked).");
      return;
    }
    setCustomError("");
    onAdd(t);
  };

  return (
    <Dialog open={open} onClose={onClose} title={`Add step${insertLabel ? ` — ${insertLabel}` : ""}`} wide>
      <Input
        autoFocus
        placeholder='Tìm step: thử "click", "text", "URL"…'
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="thin-scroll mt-3 max-h-[55vh] space-y-4 overflow-y-auto pr-1">
        {STEP_GROUPS.map((g) => {
          const items = coreResults.filter((m) => m.group === g);
          if (items.length === 0) return null;
          return (
            <section key={g}>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {g}
              </h3>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {items.map((m) => (
                  <button
                    key={m.type}
                    onClick={() => onAdd(m.type)}
                    className="flex items-start gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-left hover:border-indigo-400 hover:bg-indigo-50/40"
                  >
                    <span aria-hidden className="text-base leading-none">{m.icon}</span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
                        {m.label}
                        {m.warnFixedWait ? <Badge tone="amber">Chỉ khi cần</Badge> : null}
                      </span>
                      <span className="block truncate text-[11px] text-slate-500">
                        {m.description}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
        {/* P2 plugins: dynamic entries when GET /plugins works, manual fallback otherwise. */}
        <section>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Plugins
          </h3>
          {pluginResults.length > 0 ? (
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {pluginResults.map((m) => (
                <button
                  key={m.type}
                  onClick={() => onAdd(m.type)}
                  className="flex items-start gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-left hover:border-indigo-400 hover:bg-indigo-50/40"
                >
                  <span aria-hidden className="text-base leading-none">{m.icon}</span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
                      Custom step
                      <Badge tone="indigo">plugin</Badge>
                    </span>
                    <span className="block truncate text-[11px] text-slate-500">
                      {m.description}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-slate-500">
              {pluginsEnabled === false
                ? "Plugins đang TẮT trên server (ALLOW_PLUGINS=1 để bật) — vẫn nhập tay type bên dưới."
                : "Backend chưa liệt kê plugin (404/offline) — nhập tay type bên dưới."}
            </p>
          )}
          <div className="mt-2">
            <Field label="Hoặc nhập plugin type thủ công" hint="vd plugin:kv.fillMasked — compile báo lỗi explicit nếu plugin thiếu.">
              <span className="flex gap-2">
                <Input
                  value={customType}
                  onChange={(e) => setCustomType(e.target.value)}
                  placeholder="plugin:…"
                />
                <button
                  type="button"
                  onClick={addCustom}
                  className="shrink-0 rounded-md bg-indigo-600 px-3 text-sm font-medium text-white hover:bg-indigo-700"
                >
                  Thêm
                </button>
              </span>
            </Field>
            {customError ? <p className="mt-1 text-xs text-red-600">{customError}</p> : null}
          </div>
        </section>
        {results.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            Không tìm thấy step cho “{q}”.
          </p>
        ) : null}
      </div>
      <details className="mt-2 text-[11px] text-slate-500">
        <summary className="cursor-pointer">Advanced: step type kỹ thuật</summary>
        <p className="mt-1 font-mono">{STEP_CATALOG.map((m) => m.type).join(", ")}{pluginSteps.length > 0 ? `, ${pluginSteps.map((m) => m.type).join(", ")}` : ""}</p>
      </details>
    </Dialog>
  );
}
