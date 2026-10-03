import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AddStepPalette } from "../components/AddStepPalette";
import { Inspector } from "../components/Inspector";
import { StepCard } from "../components/StepCard";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Skeleton,
  Textarea,
  useToast,
} from "../components/ui";
import {
  ApiError,
  api,
  apiBase,
  type ActionParameter,
  type ActionRecord,
} from "../lib/api";
import { createCustomStep, createStep, isPluginStepType, type BuilderStep } from "../lib/steps";

/**
 * P1 reusable actions page (/projects/:id/actions).
 * CRUD actions: name + description + parameters table + body-steps editor
 * (reuses StepCard + Inspector + AddStepPalette; nested `callAction` is
 * hidden from the palette because action bodies must be P0 steps).
 */
export function ActionsPage() {
  const { id: projectId } = useParams();
  const toast = useToast();

  const [actions, setActions] = useState<ActionRecord[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ActionRecord | null>(null);
  const [persistedJson, setPersistedJson] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [newName, setNewName] = useState("");

  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const apiBaseOrigin = useMemo(
    () => apiBase.replace(/\/api\/v1$/, "").replace(/\/$/, "") || window.location.origin,
    [],
  );
  const currentJson = useMemo(() => (draft ? JSON.stringify(draft) : ""), [draft]);
  const dirty = draft !== null && currentJson !== persistedJson;
  const selectedStep: BuilderStep | null =
    (draft?.steps.find((s) => s.id === selectedStepId) as unknown as BuilderStep) ?? null;

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoadError("");
    try {
      const list = await api.listActions(projectId);
      setActions(list);
      setSelectedId((prev) => {
        if (prev && list.some((a) => a.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : "Không tải được actions");
      setActions([]);
    }
  }, [projectId]);

  useEffect(() => {
    setActions(null);
    setDraft(null);
    setSelectedId(null);
    void load();
  }, [load]);

  // Select → editable deep copy.
  useEffect(() => {
    if (selectedId == null) {
      setDraft(null);
      setPersistedJson("");
      return;
    }
    const found = actions?.find((a) => a.id === selectedId) ?? null;
    if (!found) return;
    const copy = JSON.parse(JSON.stringify(found)) as ActionRecord;
    setDraft(copy);
    setPersistedJson(JSON.stringify(copy));
    setSaveError("");
    setSelectedStepId(copy.steps[0]?.id ?? null);
  }, [selectedId, actions]);

  const patchDraft = (patch: Partial<ActionRecord>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };

  // -- body steps (P0 only) --
  const updateSteps = (fn: (steps: ActionRecord["steps"]) => ActionRecord["steps"]) => {
    setDraft((d) => (d ? { ...d, steps: fn(d.steps) } : d));
  };

  const addStep = (type: string) => {
    let step: BuilderStep;
    try {
      step = createStep(type);
    } catch {
      if (!isPluginStepType(type)) throw new Error(`Unknown step type: ${type}`);
      step = createCustomStep(type);
    }
    const typed = step as unknown as ActionRecord["steps"][number];
    updateSteps((steps) => {
      if (insertAt == null) return [...steps, typed];
      const next = [...steps];
      next.splice(Math.max(0, Math.min(insertAt, next.length)), 0, typed);
      return next;
    });
    setSelectedStepId(typed.id);
    setPaletteOpen(false);
    setInsertAt(null);
  };

  const patchStep = (stepId: string, patch: Partial<BuilderStep>) => {
    updateSteps((steps) =>
      steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
    );
  };

  const moveStep = (from: number, to: number) => {
    if (from === to) return;
    updateSteps((steps) => {
      const next = [...steps];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    });
  };

  // -- parameters table --
  const patchParam = (index: number, patch: Partial<ActionParameter>) => {
    setDraft((d) =>
      d
        ? { ...d, parameters: d.parameters.map((p, i) => (i === index ? { ...p, ...patch } : p)) }
        : d,
    );
  };
  const addParam = () => {
    setDraft((d) =>
      d ? { ...d, parameters: [...d.parameters, { name: `PARAM${d.parameters.length + 1}` }] } : d,
    );
  };
  const removeParam = (index: number) => {
    setDraft((d) =>
      d ? { ...d, parameters: d.parameters.filter((_, i) => i !== index) } : d,
    );
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError("");
    try {
      const saved = await api.updateAction(draft.id, {
        name: draft.name,
        description: draft.description ?? null,
        parameters: draft.parameters,
        steps: draft.steps.map((s) => ({ ...s })),
      });
      setActions((prev) => prev?.map((a) => (a.id === saved.id ? saved : a)) ?? [saved]);
      setPersistedJson(JSON.stringify(saved));
      setDraft(JSON.parse(JSON.stringify(saved)) as ActionRecord);
      toast.push("success", `Đã lưu action “${saved.name}”.`);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Lưu thất bại";
      setSaveError(msg);
      toast.push("error", msg);
    } finally {
      setSaving(false);
    }
  };

  const create = async () => {
    if (!projectId || !newName.trim()) return;
    try {
      const created = await api.createAction(projectId, {
        name: newName.trim(),
        parameters: [],
        steps: [{ id: `b_${Date.now().toString(36)}`, type: "reload", enabled: true }],
      });
      setNewName("");
      setActions((prev) => (prev ? [created, ...prev] : [created]));
      setSelectedId(created.id);
      toast.push("success", `Đã tạo action “${created.name}”.`);
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Tạo action thất bại");
    }
  };

  const remove = async () => {
    if (!draft) return;
    if (!window.confirm(`Xóa action “${draft.name}”?`)) return;
    try {
      await api.deleteAction(draft.id);
      setActions((prev) => prev?.filter((a) => a.id !== draft.id) ?? []);
      setSelectedId(null);
      toast.push("success", "Đã xóa action.");
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Xóa thất bại");
    }
  };

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-6">
      <Link to={projectId ? `/projects/${projectId}/tests` : "/projects"} className="text-sm text-slate-500 hover:text-slate-800">
        ← Tests
      </Link>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Reusable actions</h1>
        {draft ? (
          <span className="flex items-center gap-2">
            {dirty ? <Badge tone="amber">Unsaved</Badge> : <Badge tone="green">Saved</Badge>}
            <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save action"}
            </Button>
          </span>
        ) : null}
      </div>
      <p className="text-sm text-slate-500">
        Business keywords dùng chung cho nhiều test — gọi từ step <code>Call action</code> trong
        Builder. Body chỉ gồm P0 steps (không lồng <code>callAction</code>).
      </p>
      {saveError ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          {saveError}
        </p>
      ) : null}

      {actions === null ? (
        <div className="space-y-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[260px_1fr]">
          {/* Left: list + new */}
          <section className="space-y-2">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Tên action mới, vd Login"
              />
              <Button type="submit" size="sm">
                + New
              </Button>
            </form>
            {actions.length === 0 ? (
              <EmptyState title="Chưa có action" hint="Tạo action đầu tiên ở ô phía trên." />
            ) : (
              <ul className="space-y-1">
                {actions.map((a) => (
                  <li key={a.id}>
                    <button
                      onClick={() => setSelectedId(a.id)}
                      className={`w-full truncate rounded px-2 py-1.5 text-left text-sm ${
                        a.id === selectedId
                          ? "bg-indigo-50 font-medium text-indigo-800"
                          : "text-slate-600 hover:bg-slate-100"
                      }`}
                    >
                      <span className="block truncate">🔁 {a.name}</span>
                      <span className="block text-[11px] text-slate-400">
                        {a.parameters.length} params · {a.steps.length} steps
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Right: editor */}
          <section>
            {!draft ? (
              <EmptyState title="Chưa chọn action" hint="Chọn một action bên trái để chỉnh." />
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-white p-4">
                  <Field label="Action name">
                    <Input value={draft.name} onChange={(e) => patchDraft({ name: e.target.value })} />
                  </Field>
                  <Field label="Description (tùy chọn)">
                    <Textarea
                      rows={2}
                      value={draft.description ?? ""}
                      onChange={(e) => patchDraft({ description: e.target.value || undefined })}
                      placeholder="vd Đăng nhập bằng email + password"
                    />
                  </Field>
                  <p className="font-mono text-[11px] text-slate-400">{draft.id}</p>
                  <div>
                    <Button size="sm" variant="outline" onClick={() => void remove()}>
                      🗑 Delete action
                    </Button>
                  </div>
                </div>

                {/* Parameters table */}
                <div className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-slate-700">
                      Parameters <Badge>{draft.parameters.length}/50</Badge>
                    </h2>
                    <Button size="sm" variant="outline" onClick={addParam}>
                      + Add param
                    </Button>
                  </div>
                  {draft.parameters.length === 0 ? (
                    <p className="text-xs text-slate-500">
                      Chưa có param — body dùng giá trị cố định. Thêm param để caller truyền vào
                      kiểu <code>{"{{TEN_PARAM}}"}</code>.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {draft.parameters.map((p, i) => (
                        <li key={`${p.name}-${i}`} className="grid grid-cols-1 gap-2 rounded border border-slate-100 p-2 sm:grid-cols-[1fr_1fr_auto]">
                          <Field label="Name (A-Za-z0-9_)">
                            <Input value={p.name} onChange={(e) => patchParam(i, { name: e.target.value })} placeholder="EMAIL" />
                          </Field>
                          <Field label="Default (để trống = required)">
                            <Input
                              type={p.secret ? "password" : "text"}
                              value={p.default ?? ""}
                              onChange={(e) => patchParam(i, { default: e.target.value || undefined })}
                              placeholder="{{BIEN}} hoặc giá trị"
                            />
                          </Field>
                          <div className="flex items-end gap-2 pb-0.5">
                            <label className="flex items-center gap-1 text-xs text-slate-600" title="Secret params phải truyền {{BIEN}}, không inline plaintext">
                              <Checkbox checked={!!p.secret} onChange={(e) => patchParam(i, { secret: e.target.checked || undefined })} />
                              secret
                            </label>
                            <button className="text-xs text-red-600 hover:underline" onClick={() => removeParam(i)}>
                              Xóa
                            </button>
                          </div>
                          <Field label="Description (tùy chọn)">
                            <Input value={p.description ?? ""} onChange={(e) => patchParam(i, { description: e.target.value || undefined })} placeholder="vd Địa chỉ email đăng nhập" />
                          </Field>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Body steps */}
                <div className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-slate-700">
                      Body steps <Badge>{draft.steps.filter((s) => s.enabled).length}/{draft.steps.length} enabled</Badge>
                    </h2>
                    <Button
                      size="sm"
                      onClick={() => {
                        setInsertAt(null);
                        setPaletteOpen(true);
                      }}
                    >
                      + Add step
                    </Button>
                  </div>
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_320px]">
                    <ol className="space-y-2">
                      {draft.steps.map((s, i) => (
                        <li key={s.id}>
                          <StepCard
                            index={i}
                            step={s as unknown as BuilderStep}
                            selected={s.id === selectedStepId}
                            onSelect={() => setSelectedStepId(s.id)}
                            onToggleEnabled={() => patchStep(s.id, { enabled: !s.enabled })}
                            onDuplicate={() =>
                              updateSteps((steps) => {
                                const idx = steps.findIndex((x) => x.id === s.id);
                                const copy = {
                                  ...(steps[idx] as Record<string, unknown>),
                                  id: `${s.id}_copy${Date.now().toString(36)}`,
                                } as ActionRecord["steps"][number];
                                const next = [...steps];
                                next.splice(idx + 1, 0, copy);
                                return next;
                              })
                            }
                            onDelete={() => {
                              if (!window.confirm("Xóa step này?")) return;
                              updateSteps((steps) => steps.filter((x) => x.id !== s.id));
                              if (selectedStepId === s.id) setSelectedStepId(null);
                            }}
                            onInsertBefore={() => {
                              setInsertAt(i);
                              setPaletteOpen(true);
                            }}
                            onInsertAfter={() => {
                              setInsertAt(i + 1);
                              setPaletteOpen(true);
                            }}
                            onDragStart={setDragIndex}
                            onDrop={(to) => {
                              if (dragIndex !== null) moveStep(dragIndex, to);
                              setDragIndex(null);
                            }}
                            draggable
                          />
                        </li>
                      ))}
                    </ol>
                    <aside className="rounded-md border border-slate-100 p-3">
                      <h3 className="mb-2 text-sm font-semibold text-slate-700">Inspector</h3>
                      {selectedStep ? (
                        <Inspector
                          step={selectedStep}
                          onPatch={(p) => patchStep(selectedStep.id, p)}
                          apiBase={apiBaseOrigin}
                          projectId={projectId}
                        />
                      ) : (
                        <EmptyState title="Chưa chọn step" hint="Click một step để chỉnh." />
                      )}
                    </aside>
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      <AddStepPalette
        open={paletteOpen}
        onClose={() => {
          setPaletteOpen(false);
          setInsertAt(null);
        }}
        onAdd={addStep}
        insertLabel={insertAt != null ? `at #${insertAt + 1}` : undefined}
        excludeTypes={["callAction"]}
      />
    </main>
  );
}
