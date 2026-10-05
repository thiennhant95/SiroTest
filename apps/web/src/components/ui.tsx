import React, { createContext, useCallback, useContext, useState } from "react";

/* shadcn-style minimal primitives (Tailwind). Shared by all screens. */

export function Button({
  variant = "default",
  size = "md",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "secondary" | "outline" | "ghost" | "destructive";
  size?: "sm" | "md" | "icon";
}) {
  const variants: Record<string, string> = {
    default: "bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-slate-300",
    secondary: "bg-slate-100 text-slate-900 hover:bg-slate-200 disabled:opacity-50",
    outline: "border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50",
    ghost: "hover:bg-slate-100 disabled:opacity-50",
    destructive: "bg-red-600 text-white hover:bg-red-700 disabled:bg-slate-300",
  };
  const sizes: Record<string, string> = {
    sm: "h-7 px-2.5 text-xs",
    md: "h-9 px-4 text-sm",
    icon: "h-7 w-7 text-sm",
  };
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  props,
  ref,
) {
  return (
    <input
      ref={ref}
      {...props}
      className={`h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm placeholder:text-slate-400 disabled:bg-slate-100 disabled:opacity-60 ${props.className ?? ""}`}
    />
  );
});

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs disabled:bg-slate-100 ${props.className ?? ""}`}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm disabled:bg-slate-100 ${props.className ?? ""}`}
    />
  );
}

export function Checkbox(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      {...props}
      className={`h-4 w-4 accent-indigo-600 ${props.className ?? ""}`}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-slate-500">{hint}</span> : null}
    </label>
  );
}

export function Badge({
  tone = "slate",
  title,
  children,
}: {
  tone?: "slate" | "green" | "red" | "amber" | "indigo";
  title?: string;
  children: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-700",
    green: "bg-green-100 text-green-800",
    red: "bg-red-100 text-red-800",
    amber: "bg-amber-100 text-amber-800",
    indigo: "bg-indigo-100 text-indigo-800",
  };
  return (
    <span title={title} className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-slate-200">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
            value === t.value
              ? "border-indigo-600 text-indigo-700"
              : "border-transparent text-slate-500 hover:text-slate-800"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`max-h-[85vh] w-full ${wide ? "max-w-2xl" : "max-w-md"} overflow-hidden rounded-lg bg-white shadow-xl`}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100">
            ✕
          </button>
        </div>
        <div className="overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

/** Keyboard-accessible tooltip: hover/focus reveals hint; trigger stays focusable. */
export function Tooltip({
  tip,
  children,
}: {
  tip: string;
  children: React.ReactNode;
}) {
  return (
    // NOTE: named group (group/tip) — a plain `group` class here would clash
    // with ancestor `.group` containers (e.g. StepCard hover-reveal rows),
    // showing every nested tooltip at once, stacked on each other.
    <span className="group/tip relative inline-flex" tabIndex={0} aria-label={tip} title={tip}>
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-slate-200 bg-slate-900 px-2 py-1 text-[11px] text-white shadow-lg group-hover/tip:block group-focus-visible/tip:block group-focus/tip:block"
      >
        {tip}
      </span>
    </span>
  );
}

export interface DataTableColumn<R> {
  key: string;
  header: string;
  render?: (row: R) => React.ReactNode;
}

export function DataTable<R extends { id: string }>({
  columns,
  rows,
  emptyText = "No data yet.",
  caption,
}: {
  columns: DataTableColumn<R>[];
  rows: R[];
  emptyText?: string;
  caption?: string;
}) {
  if (rows.length === 0) {
    return <p className="py-3 text-center text-xs text-slate-500">{emptyText}</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full border-collapse text-sm">
        {caption ? <caption className="px-3 py-2 text-left text-xs text-slate-500">{caption}</caption> : null}
        <thead>
          <tr className="border-b-2 border-slate-200 bg-slate-50 text-left">
            {columns.map((c) => (
              <th key={c.key} scope="col" className="px-3 py-2 text-xs font-semibold text-slate-600">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
              {columns.map((c) => (
                <td key={c.key} className="px-3 py-2 align-top">
                  {c.render
                    ? c.render(r)
                    : String((r as Record<string, unknown>)[c.key] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={title}>
      <div
        className="absolute inset-0 bg-black/40"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-sm flex-col bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-indigo-600"
          >
            ✕
          </button>
        </div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </aside>
    </div>
  );
}

/** Progressively-disclosed technical details (locator JSON, raw step, …). */
export function Advanced({ title = "Advanced", children }: { title?: string; children: React.ReactNode }) {
  return (
    <details className="rounded-md border border-slate-200 bg-slate-50">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-slate-600">
        {title} <span className="text-slate-400">(locator JSON / technical)</span>
      </summary>
      <div className="space-y-3 border-t border-slate-200 px-3 py-3">{children}</div>
    </details>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {hint ? <p className="max-w-sm text-xs text-slate-500">{hint}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-10 text-center">
      <p className="text-sm font-medium text-red-800">Something went wrong</p>
      <p className="max-w-md text-xs text-red-700">{message}</p>
      {onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function Skeleton({ className = "", lines, label }: { className?: string; lines?: number; label?: string }) {
  if (lines) {
    return (
      <div className="space-y-2" aria-label={label ?? "Loading"}>
        {Array.from({ length: lines }).map((_, i) => (
          <div key={i} className={`animate-pulse rounded-md bg-slate-200 ${className || "h-4"}`} />
        ))}
        {label ? <p className="text-xs text-slate-500">{label}</p> : null}
      </div>
    );
  }
  return <div className={`animate-pulse rounded-md bg-slate-200 ${className}`} />;
}

export function RunStatusBadge({ status }: { status: string }) {
  const tone = status === "passed" ? "green" : status === "failed" ? "red" : status === "running" ? "indigo" : status === "cancelled" ? "amber" : "slate";
  return <Badge tone={tone as "slate" | "green" | "red" | "amber" | "indigo"}>{status}</Badge>;
}

export function RoleSwitch({ role, onChange }: { role: "tester" | "developer"; onChange: (r: "tester" | "developer") => void }) {
  return (
    <label className="flex items-center gap-1 text-xs text-slate-600">
      Role:
      <select aria-label="Role" value={role} onChange={(e) => onChange(e.target.value as "tester" | "developer")} className="h-7 rounded-md border border-slate-300 bg-white px-1 text-xs">
        <option value="tester">Tester</option>
        <option value="developer">Developer</option>
      </select>
    </label>
  );
}

// ------------------------------------------------------------------ toast ---

interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  message: string;
}

const ToastCtx = createContext<{ push: (kind: Toast["kind"], message: string) => void }>({
  push: () => {},
});

export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast["kind"], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, message }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded-md border px-3 py-2 text-sm shadow-lg ${
              t.kind === "error"
                ? "border-red-200 bg-red-50 text-red-800"
                : t.kind === "success"
                  ? "border-green-200 bg-green-50 text-green-800"
                  : "border-slate-200 bg-white text-slate-800"
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
