import { useEffect, useRef, useState } from "react";
import { api, type Variable } from "../lib/api";
import { interpolatePreview } from "../lib/variables";
import { Badge, Input } from "./ui";

/**
 * Text input with a {{VARIABLE}} picker + resolved preview.
 * Typing variable names by hand is error-prone (case-sensitive, must exist);
 * the picker inserts exact keys, and the preview shows what the runner sees
 * (secrets stay masked — they resolve server-side at run time).
 */
export function VariableInput({
  value,
  onChange,
  placeholder,
  projectId,
  type = "text",
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  projectId?: string;
  type?: string;
  ariaLabel?: string;
}) {
  const [vars, setVars] = useState<Variable[] | null>(null);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!projectId || projectId === "demo") {
      setVars([]);
      return;
    }
    let alive = true;
    api
      .listVariables(projectId)
      .then((list) => {
        if (alive) setVars(list);
      })
      .catch(() => {
        if (alive) setVars([]);
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  const insert = (key: string) => {
    const el = inputRef.current;
    const token = `{{${key}}}`;
    if (!el) {
      onChange(`${value}${token}`);
    } else {
      const start = el.selectionStart ?? value.length;
      const end = el.selectionEnd ?? value.length;
      onChange(`${value.slice(0, start)}${token}${value.slice(end)}`);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + token.length;
        el.setSelectionRange(pos, pos);
      });
    }
    setOpen(false);
  };

  const hasToken = /\{\{\s*[A-Za-z_]/.test(value);
  const preview = vars && hasToken ? interpolatePreview(value, vars, null) : null;

  return (
    <div>
      <div className="flex gap-1.5">
        <Input
          ref={inputRef}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className="font-mono"
        />
        <div className="relative shrink-0">
          <button
            type="button"
            title="Insert variable"
            aria-label="Insert variable"
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="h-9 rounded-md border border-slate-300 bg-white px-2.5 font-mono text-sm text-indigo-700 hover:border-indigo-400 hover:bg-indigo-50"
          >
            {"{ }"}
          </button>
          {open ? (
            <>
              <span className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
              <span role="listbox" className="absolute right-0 z-20 mt-1 max-h-56 w-64 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                {vars === null ? (
                  <span className="block px-3 py-2 text-xs text-slate-500">Loading variables…</span>
                ) : vars.length === 0 ? (
                  <span className="block px-3 py-2 text-xs text-slate-500">
                    No variables yet — add them in the Variables tab.
                  </span>
                ) : (
                  vars.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      role="option"
                      aria-selected={false}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-50"
                      onClick={() => insert(v.key)}
                      title={v.isSecret ? "Secret — resolves at run time, never shown" : (v.value ?? "")}
                    >
                      <code className="font-mono text-xs font-semibold text-indigo-700">{v.key}</code>
                      {v.isSecret ? <Badge tone="amber">secret</Badge> : null}
                      {!v.environmentId ? <span className="text-[11px] text-slate-400">shared</span> : null}
                    </button>
                  ))
                )}
              </span>
            </>
          ) : null}
        </div>
      </div>
      {preview !== null && preview !== value ? (
        <p className="mt-1 truncate font-mono text-[11px] text-slate-500" title={preview}>
          → {preview}
        </p>
      ) : null}
    </div>
  );
}
