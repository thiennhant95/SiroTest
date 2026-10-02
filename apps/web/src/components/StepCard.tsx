import { Badge } from "./ui";
import { STEP_META, businessName, targetSummary, type BuilderStep } from "../lib/steps";

export type StepStatus = "idle" | "running" | "failed";

export function StepCard({
  index,
  step,
  selected,
  status = "idle",
  onSelect,
  onToggleEnabled,
  onDuplicate,
  onDelete,
  onInsertBefore,
  onInsertAfter,
  onDragStart,
  onDrop,
  draggable,
}: {
  index: number;
  step: BuilderStep;
  selected: boolean;
  status?: StepStatus;
  onSelect: () => void;
  onToggleEnabled: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onInsertBefore: () => void;
  onInsertAfter: () => void;
  onDragStart: (index: number) => void;
  onDrop: (index: number) => void;
  draggable: boolean;
}) {
  const meta = STEP_META[step.type];
  const target = (step as { target?: unknown }).target;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-selected={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart(index);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(index);
      }}
      className={`group w-full rounded-lg border bg-white px-3 py-2 text-left shadow-sm transition-colors ${
        selected ? "border-indigo-500 ring-1 ring-indigo-500" : "border-slate-200 hover:border-slate-300"
      } ${step.enabled ? "" : "opacity-60"}`}
    >
      <div className="flex items-center gap-2">
        <span className="w-6 shrink-0 text-xs font-semibold text-slate-400">{index + 1}</span>
        <span aria-hidden className="shrink-0 text-base leading-none">
          {meta?.icon ?? "•"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-slate-800">
            {businessName(step)}
          </span>
          <span className="block truncate text-[11px] text-slate-500">
            {meta?.label ?? step.type}
            {target ? ` · ${targetSummary(target)}` : ""}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {status === "running" ? <Badge tone="indigo">running</Badge> : null}
          {status === "failed" ? <Badge tone="red">failed</Badge> : null}
          {!step.enabled ? <Badge>disabled</Badge> : null}
        </span>
      </div>
      <div
        className="mt-1.5 hidden flex-wrap gap-1 group-hover:flex group-focus-within:flex"
        onClick={(e) => e.stopPropagation()}
      >
        <MiniBtn title={step.enabled ? "Disable" : "Enable"} onClick={onToggleEnabled}>
          {step.enabled ? "⏸" : "▶"}
        </MiniBtn>
        <MiniBtn title="Duplicate" onClick={onDuplicate}>⧉</MiniBtn>
        <MiniBtn title="Insert before" onClick={onInsertBefore}>↑+</MiniBtn>
        <MiniBtn title="Insert after" onClick={onInsertAfter}>↓+</MiniBtn>
        <MiniBtn title="Delete" onClick={onDelete}>🗑</MiniBtn>
      </div>
    </div>
  );
}

function MiniBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100"
    >
      {children}
    </button>
  );
}
