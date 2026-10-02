import { useMemo, useState } from "react";
import { Badge, Dialog, Input } from "./ui";
import { STEP_GROUPS, searchCatalog } from "../lib/steps";

/** Add-step palette grouped Nav/Interaction/Wait/Assertion/Utility + human search. */
export function AddStepPalette({
  open,
  onClose,
  onAdd,
  insertLabel,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (type: string) => void;
  insertLabel?: string;
}) {
  const [q, setQ] = useState("");
  const results = useMemo(() => searchCatalog(q), [q]);

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
          const items = results.filter((m) => m.group === g);
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
                        {m.description} · <code>{m.type}</code>
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
        {results.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            Không tìm thấy step cho “{q}”.
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
