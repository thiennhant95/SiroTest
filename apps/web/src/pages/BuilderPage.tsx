import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AddStepPalette } from "../components/AddStepPalette";
import { AssertionPickerModal, type InsertPosition } from "../components/AssertionPickerModal";
import { DatasetsTab } from "../components/DatasetsTab";
import { EnvironmentsPanel } from "../components/EnvironmentsPanel";
import { GherkinTab } from "../components/GherkinTab";
import { Inspector } from "../components/Inspector";
import { RunModal } from "../components/RunModal";
import { BuilderTour, restartBuilderTour } from "../components/GuidedTour";
import { StepCard } from "../components/StepCard";
import { SuggestionsPanel } from "../components/SuggestionsPanel";
import { VariablesTab } from "../components/VariablesTab";
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
  Tabs,
  Tooltip,
  useToast,
} from "../components/ui";
import { ApiError, api, apiBase, parseDefinition, type Environment, type Variable } from "../lib/api";
import type { BuilderStep as AssertionBuilderStep, StepTestResult } from "../builder/types";
import {
  createCustomStep,
  createStep,
  demoDefinition,
  isPluginStepType,
  type BuilderDefinition,
  type BuilderStep,
} from "../lib/steps";
import { CodeTab } from "./builder/CodeTab";
import { HistoryTab } from "./builder/HistoryTab";

type BottomTab = "steps" | "variables" | "datasets" | "runs" | "code" | "history" | "suggest" | "gherkin";
type SaveState = "saved" | "saving" | "error";

/**
 * Primary builder (/tests/:id) per 10-ui-ux/screens.md + visual-builder.md:
 * Header (name + env + Record + Run) | 3 columns (tree / steps / inspector)
 * | bottom tabs (Steps|Variables|Runs|Code|History).
 * Autosave debounce; Run disabled while dirty (always uses persisted revision).
 */
export function BuilderPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();

  const [definition, setDefinition] = useState<BuilderDefinition | null>(null);
  const [projectId, setProjectId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [offline, setOffline] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [treeQuery, setTreeQuery] = useState("");
  const [bottomTab, setBottomTab] = useState<BottomTab>("steps");
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Where the next palette pick lands: null = append. */
  const [insertAt, setInsertAt] = useState<{ index: number; label: string } | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [envId, setEnvId] = useState("");
  const [variables, setVariables] = useState<Variable[]>([]);
  const [knownSecrets, setKnownSecrets] = useState<string[]>(() => {
    try {
      const raw = sessionStorage.getItem("vv_known_secrets");
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });
  const [showEnvs, setShowEnvs] = useState(false);
  const [showRunModal, setShowRunModal] = useState(false);
  const [showInspector, setShowInspector] = useState(false);
  // -- locator picker wiring (05-locator): session + per-step test results + assertion modal --
  const [sessionId, setSessionId] = useState("");
  const [testResults, setTestResults] = useState<Record<string, StepTestResult | null>>({});
  const [assertionOpen, setAssertionOpen] = useState(false);

  // -- autosave --
  const [persistedJson, setPersistedJson] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState("");
  const saveTimer = useRef<number | undefined>(undefined);

  const currentJson = useMemo(
    () => (definition ? JSON.stringify(definition) : ""),
    [definition],
  );
  const dirty = currentJson !== persistedJson;

  const selectedStep: BuilderStep | null =
    definition?.steps.find((s) => s.id === selectedId) ?? null;

  // Origin for testLocator/setPickMode (they append /api/v1/…). apiBase includes /api/v1.
  const apiBaseOrigin = useMemo(() => apiBase.replace(/\/api\/v1$/, "").replace(/\/$/, "") || window.location.origin, []);
  const unhealthy = useMemo(
    () => (definition?.steps ?? []).filter((s) => testResults[s.id] && !testResults[s.id]!.canSave),
    [definition, testResults],
  );

  // Deep-link from run detail (?focusStep=<stepId>): auto-select failing step.
  const [searchParams, setSearchParams] = useSearchParams();
  const focusStepId = searchParams.get("focusStep");
  useEffect(() => {
    if (!focusStepId || !definition) return;
    if (definition.steps.some((s) => s.id === focusStepId)) {
      setSelectedId(focusStepId);
    }
  }, [focusStepId, definition]);
  const focusStep = focusStepId
    ? (definition?.steps.find((s) => s.id === focusStepId) ?? null)
    : null;
  const clearFocusStep = () => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("focusStep");
        return next;
      },
      { replace: true },
    );
  };

  const reloadEnvs = useCallback(async (pid: string) => {
    try {
      const envs = await api.listEnvironments(pid);
      setEnvironments(envs);
      setEnvId((prev) => {
        if (prev && envs.some((e) => e.id === prev)) return prev;
        return envs.find((e) => e.isDefault)?.id ?? envs[0]?.id ?? "";
      });
    } catch {
      /* envs optional */
    }
  }, []);

  const reloadVariables = useCallback(async (pid: string) => {
    if (!pid || pid === "demo") return;
    try {
      setVariables(await api.listVariables(pid));
    } catch {
      /* variables optional — tab shows error/empty */
    }
  }, []);

  const handleSecretTyped = useCallback((plaintext: string) => {
    if (!plaintext) return;
    setKnownSecrets((prev) => {
      if (prev.includes(plaintext)) return prev;
      const next = [...prev, plaintext].slice(-20);
      try {
        sessionStorage.setItem("vv_known_secrets", JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });
  }, []);

  // -- load --
  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadError("");
    try {
      const record = await api.getTest(id);
      const parsed = parseDefinition(record.definitionJson) as unknown as BuilderDefinition;
      setDefinition(parsed);
      setProjectId(record.projectId);
      setPersistedJson(JSON.stringify(parsed));
      setSelectedId(parsed.steps[0]?.id ?? null);
      setSaveState("saved");
      setOffline(false);
      await reloadEnvs(record.projectId);
      await reloadVariables(record.projectId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) {
        // API server chưa chạy: offline demo để vẫn thao tác được UI.
        const demo = demoDefinition(id);
        setDefinition(demo);
        setProjectId(demo.projectId);
        setPersistedJson(JSON.stringify(demo));
        setSelectedId(demo.steps[0]?.id ?? null);
        setOffline(true);
      } else {
        setLoadError(e instanceof ApiError ? e.message : "Could not load test");
      }
    } finally {
      setLoading(false);
    }
  }, [id, reloadEnvs, reloadVariables]);

  useEffect(() => {
    void load();
  }, [load]);

  // -- autosave (debounce 800ms) --
  useEffect(() => {
    if (!definition || loading || !id || offline) return;
    if (currentJson === persistedJson) return;
    setSaveState("saving");
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      try {
        await api.saveTest(id, definition as never);
        setPersistedJson(currentJson);
        setSaveState("saved");
        setSaveError("");
      } catch (e) {
        setSaveState("error");
        setSaveError(e instanceof ApiError ? e.message : "Autosave failed");
      }
    }, 800);
    return () => window.clearTimeout(saveTimer.current);
  }, [currentJson, definition, persistedJson, loading, id, offline]);

  // -- mutations --
  const updateSteps = (fn: (steps: BuilderStep[]) => BuilderStep[]) => {
    setDefinition((d) => (d ? { ...d, steps: fn(d.steps) } : d));
  };

  const addStep = (type: string) => {
    // Manual `plugin:*` types bypass the static catalog (schema comes from GET /plugins).
    let step: BuilderStep;
    try {
      step = createStep(type);
    } catch {
      if (!isPluginStepType(type)) throw new Error(`Unknown step type: ${type}`);
      step = createCustomStep(type);
    }
    updateSteps((steps) => {
      if (!insertAt) return [...steps, step];
      const next = [...steps];
      next.splice(Math.max(0, Math.min(insertAt.index, next.length)), 0, step);
      return next;
    });
    setSelectedId(step.id);
    setPaletteOpen(false);
    setInsertAt(null);
  };

  const patchStep = (stepId: string, patch: Partial<BuilderStep>) => {
    updateSteps((steps) => steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)));
  };

  const duplicateStep = (stepId: string) => {
    updateSteps((steps) => {
      const i = steps.findIndex((s) => s.id === stepId);
      if (i < 0) return steps;
      const copy: BuilderStep = { ...steps[i], id: `${steps[i].id}_copy${Date.now().toString(36)}`, name: steps[i].name ? `${steps[i].name} (copy)` : undefined };
      const next = [...steps];
      next.splice(i + 1, 0, copy);
      return next;
    });
  };

  const deleteStep = (stepId: string) => {
    if (!window.confirm("Delete this step?")) return;
    updateSteps((steps) => steps.filter((s) => s.id !== stepId));
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[stepId];
      return next;
    });
    if (selectedId === stepId) setSelectedId(null);
  };

  /** (4) Insert assertion from AssertionPickerModal before/after the anchor step. */
  const insertAssertion = (assertion: AssertionBuilderStep, anchorId: string, position: InsertPosition) => {
    const converted = assertion as unknown as BuilderStep;
    updateSteps((steps) => {
      const idx = steps.findIndex((s) => s.id === anchorId);
      if (idx < 0) return [...steps, converted];
      const at = position === "before" ? idx : idx + 1;
      return [...steps.slice(0, at), converted, ...steps.slice(at)];
    });
    setSelectedId(converted.id);
  };

  const moveStep = (from: number, to: number) => {
    if (from === to) return;
    updateSteps((steps) => {
      const next = [...steps];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const openPaletteAt = (index: number, label: string) => {
    setInsertAt({ index, label });
    setPaletteOpen(true);
  };

  // -- run (always uses persisted revision) --
  // Nút Run mở RunModal (chọn env/browser/headed) → api.createRun → navigate /runs/:id.
  const runDisabled = dirty || saveState === "saving" || !envId;
  const runHint = offline
    ? "Offline demo — start the API server to run."
    : !envId
      ? "Select an environment to run."
      : dirty || saveState === "saving"
        ? "Saving draft… Run is available once saved (runs always use the persisted revision)."
        : "Run the saved revision.";

  const envName = environments.find((e) => e.id === envId)?.name ?? "";
  const defTags: string[] = Array.isArray(definition?.tags)
    ? definition.tags!.filter((t): t is string => typeof t === "string")
    : [];

  // -- render states --
  if (loading) {
    return (
      <main className="space-y-3 p-6">
        <Skeleton className="h-12" />
        <div className="grid grid-cols-3 gap-3">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </main>
    );
  }

  if (!definition) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <ErrorState message={loadError || "Test not found"} onRetry={load} />
        <p className="mt-3">
          <Link to="/projects" className="text-sm text-indigo-700 hover:underline">
            ← Back to Projects
          </Link>
        </p>
      </main>
    );
  }

  const visibleSteps = definition.steps.filter((s) => {
    const q = treeQuery.trim().toLowerCase();
    if (!q) return true;
    return [s.name ?? "", s.type, s.id].join(" ").toLowerCase().includes(q);
  });

  return (
    <main className="flex h-screen flex-col bg-slate-50">
      {/* ================= Header ================= */}
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2">
        <Link to={projectId && projectId !== "demo" ? `/projects/${projectId}/tests` : "/projects"} className="text-slate-500 hover:text-slate-800" title="Back to tests">
          ←
        </Link>
        <Input
          aria-label="Test name"
          value={definition.name}
          onChange={(e) => setDefinition({ ...definition, name: e.target.value })}
          className="max-w-xs font-semibold"
        />
        {defTags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1" title={`Tests tagged ${t}`}>
            <Link to={projectId && projectId !== "demo" ? `/projects/${projectId}/tests?tag=${encodeURIComponent(t)}` : "/projects"}>
              <Badge tone="slate">#{t}</Badge>
            </Link>
            <button
              type="button"
              aria-label={`Remove tag ${t}`}
              title={`Remove tag ${t} (autosave PATCH definition.tags)`}
              className="text-xs text-slate-400 hover:text-red-600"
              onClick={() =>
                setDefinition((d) => (d ? { ...d, tags: (d.tags ?? []).filter((x) => x !== t) } : d))
              }
            >
              ×
            </button>
          </span>
        ))}
        <TagsEditor
          disabled={offline}
          onAdd={(t) =>
            setDefinition((d) => {
              if (!d) return d;
              const cur = d.tags ?? [];
              if (cur.includes(t)) return d;
              return { ...d, tags: [...cur, t] };
            })
          }
        />
        <Select aria-label="Environment" value={envId} onChange={(e) => setEnvId(e.target.value)} className="w-44">
          <option value="">Environment…</option>
          {environments.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </Select>
        <Button size="sm" variant="outline" onClick={() => setShowEnvs(true)} disabled={offline || !projectId || projectId === "demo"} title="Manage environments">
          ⚙ Envs
        </Button>
        {projectId && projectId !== "demo" ? (
          <ProjectMenu projectId={projectId} nav={nav} />
        ) : null}
        <Input
          aria-label="Recorder session"
          title="Recorder session — enables Pick from page + Test locator on live page"
          placeholder="Recorder session…"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          className="w-44"
        />
        <span className="ml-auto flex items-center gap-2">
          <AutosaveBadge state={offline ? "saved" : saveState} dirty={dirty} error={saveError} offline={offline} />
          {id ? <StabilityBadge testId={id} envId={envId} offline={offline} version={persistedJson} /> : null}
          <Tooltip tip="Open Inspector in the slide-over panel (mobile)">
            <Button size="sm" variant="outline" className="md:hidden" onClick={() => setShowInspector(true)}>
              Inspector
            </Button>
          </Tooltip>
          <Tooltip tip="Record actions into steps">
            <Button size="sm" variant="outline" onClick={() => nav(`/tests/${id}/record`)}>
              ● Record
            </Button>
          </Tooltip>
          <span title={runHint}>
            <Tooltip tip={runDisabled ? runHint : "Run the saved revision"}>
              <span data-tour="run">
                <Button size="sm" disabled={runDisabled} onClick={() => setShowRunModal(true)}>
                  ▶ Run
                </Button>
              </span>
            </Tooltip>
          </span>
          <Tooltip tip="Replay the guided tour">
            <Button size="sm" variant="ghost" onClick={() => restartBuilderTour()} aria-label="Replay guided tour">
              ?
            </Button>
          </Tooltip>
        </span>
      </header>
      {offline ? (
        <p className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800">
          Offline demo mode — could not reach the API (<code>/api/v1</code>). Start the server in{" "}
          <code>apps/server</code> then reload to persist (GET/PATCH /tests/:id).
        </p>
      ) : null}
      {unhealthy.length > 0 ? (
        <p role="alert" className="border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs text-red-800">
          {unhealthy.length} step(s) match 0 elements and cannot be saved as healthy:{" "}
          {unhealthy.map((s) => s.name ?? s.type).join(", ")}.
        </p>
      ) : null}
      {focusStepId ? (
        <p className="flex flex-wrap items-center gap-2 border-b border-indigo-200 bg-indigo-50 px-4 py-1.5 text-xs text-indigo-900">
          {focusStep ? (
            <span>
              Focusing the failed step from run detail:{" "}
              <strong>
                {definition?.steps.indexOf(focusStep) !== undefined
                  ? `#${(definition?.steps.indexOf(focusStep) ?? 0) + 1} `
                  : null}
                {focusStep.name ?? focusStep.type}
              </strong>{" "}
              <code className="rounded bg-indigo-100 px-1">{focusStep.id}</code>
            </span>
          ) : (
            <span>
              Step <code>{focusStepId}</code> was not found in this test (the definition may have changed).
            </span>
          )}
          <button className="text-indigo-700 underline hover:text-indigo-900" onClick={clearFocusStep}>
            Clear focus
          </button>
        </p>
      ) : null}

      {/* ================= 3 columns ================= */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 md:grid-cols-[240px_1fr_320px]">
        {/* Left: test tree / search */}
        <aside className="thin-scroll hidden min-h-0 flex-col gap-2 overflow-y-auto border-r border-slate-200 bg-white p-3 md:flex">
          <Input
            placeholder="Search steps…"
            aria-label="Search steps"
            value={treeQuery}
            onChange={(e) => setTreeQuery(e.target.value)}
          />
          <p className="text-[11px] uppercase tracking-wide text-slate-400">
            Test tree · {definition.steps.length} steps
          </p>
          <ul className="space-y-1">
            {visibleSteps.map((s, i) => (
              <li key={s.id}>
                <button
                  onClick={() => setSelectedId(s.id)}
                  className={`w-full truncate rounded px-2 py-1 text-left text-xs ${
                    s.id === selectedId ? "bg-indigo-50 font-medium text-indigo-800" : "text-slate-600 hover:bg-slate-100"
                  } ${s.enabled ? "" : "line-through opacity-60"}`}
                >
                  {definition.steps.indexOf(s) + 1}. {s.name ?? s.type}
                  {i !== visibleSteps.indexOf(s) ? null : null}
                </button>
              </li>
            ))}
          </ul>
          {visibleSteps.length === 0 ? (
            <p className="text-xs text-slate-400">No matching steps.</p>
          ) : null}
        </aside>

        {/* Middle: steps list */}
        <section data-tour="steps" className="thin-scroll min-h-0 overflow-y-auto p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">
              Steps <Badge>{definition.steps.filter((s) => s.enabled).length}/{definition.steps.length} enabled</Badge>
            </h2>
            <Button
              size="sm"
              data-tour="add-step"
              onClick={() => {
                setInsertAt(null);
                setPaletteOpen(true);
              }}
            >
              + Add step
            </Button>
          </div>
          {definition.steps.length === 0 ? (
            <EmptyState
              title="This test has no steps"
              hint="Click Add step and search familiar terms: click, text, URL…"
              action={
                <Button size="sm" onClick={() => setPaletteOpen(true)}>
                  + Add step
                </Button>
              }
            />
          ) : (
            <ol className="space-y-2">
              {definition.steps.map((s, i) => (
                <li key={s.id}>
                  <StepCard
                    index={i}
                    step={s}
                    selected={s.id === selectedId}
                    onSelect={() => setSelectedId(s.id)}
                    onToggleEnabled={() => patchStep(s.id, { enabled: !s.enabled })}
                    onDuplicate={() => duplicateStep(s.id)}
                    onDelete={() => deleteStep(s.id)}
                    onInsertBefore={() => openPaletteAt(i, `before #${i + 1}`)}
                    onInsertAfter={() => openPaletteAt(i + 1, `after #${i + 1}`)}
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
          )}
          {definition.steps.length > 0 ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => {
                setInsertAt(null);
                setPaletteOpen(true);
              }}
            >
              + Add step
            </Button>
          ) : null}
        </section>

        {/* Right: inspector */}
        <aside data-tour="inspector" className="thin-scroll min-h-0 overflow-y-auto border-l border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Inspector</h2>
          {selectedStep ? (
            <Inspector
              step={selectedStep}
              onPatch={(p) => patchStep(selectedStep.id, p)}
              apiBase={apiBaseOrigin}
              projectId={projectId || undefined}
              testId={id}
              sessionId={sessionId.trim() || undefined}
              testResult={testResults[selectedStep.id] ?? null}
              onTestResult={(r) =>
                setTestResults((prev) => ({ ...prev, [selectedStep.id]: r }))
              }
              onAddAssertion={() => setAssertionOpen(true)}
            />
          ) : (
            <EmptyState title="No step selected" hint="Click a step in the middle column to edit it in the Inspector." />
          )}
        </aside>
      </div>

      {/* ================= Bottom tabs ================= */}
      <footer data-tour="tabs" className="border-t border-slate-200 bg-white">
        <div className="px-4 pt-1">
          <Tabs<BottomTab>
            value={bottomTab}
            onChange={setBottomTab}
            tabs={[
              { value: "steps", label: `Steps (${definition.steps.length})` },
              { value: "variables", label: offline ? `Variables (${Object.keys(definition.variables ?? {}).length})` : `Variables (${variables.length})` },
              { value: "datasets", label: `Datasets (${definition.datasets?.length ?? 0})` },
              { value: "runs", label: "Runs" },
              { value: "code", label: "Code" },
              { value: "history", label: "History" },
              { value: "suggest", label: "Suggest" },
              { value: "gherkin", label: "Gherkin" },
            ]}
          />
        </div>
        <div className="thin-scroll max-h-48 min-h-24 overflow-y-auto px-4 py-3">
          {bottomTab === "steps" ? (
            <p className="text-xs text-slate-500">
              {definition.steps.length} steps · {definition.steps.filter((s) => !s.enabled).length} disabled ·
              browser <code>{definition.browser}</code>
              {definition.baseUrl ? <> · baseUrl <code>{definition.baseUrl}</code></> : null}
            </p>
          ) : null}
          {bottomTab === "variables" ? (
            offline || !projectId || projectId === "demo" ? (
              <VariablesEditor
                variables={definition.variables ?? {}}
                onChange={(vars) => setDefinition({ ...definition, variables: vars })}
              />
            ) : (
              <VariablesTab
                projectId={projectId}
                envId={envId || null}
                envName={envName}
                variables={variables}
                onChanged={() => void reloadVariables(projectId)}
                onSecretTyped={handleSecretTyped}
              />
            )
          ) : null}
          {bottomTab === "runs" ? <RunsPanel testId={id!} /> : null}
          {bottomTab === "datasets" ? (
            <DatasetsTab
              testId={id!}
              datasets={definition.datasets ?? []}
              onChanged={(definitionJson) => {
                // Server already persisted + versioned the import/delete;
                // adopt it as both current and saved (autosave stays green).
                const next = definitionJson as BuilderDefinition;
                setDefinition(next);
                setPersistedJson(JSON.stringify(next));
                setSaveState("saved");
              }}
            />
          ) : null}
          {bottomTab === "code" ? <CodeTab testId={id!} testName={definition.name} /> : null}
          {bottomTab === "history" ? <HistoryTab testId={id!} /> : null}
          {bottomTab === "suggest" ? (
            <SuggestionsPanel testId={id!} onApplied={() => void load()} />
          ) : null}
          {bottomTab === "gherkin" ? (
            <GherkinTab testId={id!} projectId={projectId || undefined} onInserted={() => void load()} />
          ) : null}
        </div>
      </footer>

      <AddStepPalette
        open={paletteOpen}
        onClose={() => {
          setPaletteOpen(false);
          setInsertAt(null);
        }}
        onAdd={addStep}
        insertLabel={insertAt?.label}
      />

      {/* Mobile: Inspector lives in a Drawer; desktop keeps the right aside. */}
      <Drawer open={showInspector} onClose={() => setShowInspector(false)} title="Inspector">
        {selectedStep ? (
          <Inspector
            step={selectedStep}
            onPatch={(p) => patchStep(selectedStep.id, p)}
            apiBase={apiBaseOrigin}
            projectId={projectId || undefined}
            testId={id}
            sessionId={sessionId.trim() || undefined}
            testResult={testResults[selectedStep.id] ?? null}
            onTestResult={(r) =>
              setTestResults((prev) => ({ ...prev, [selectedStep.id]: r }))
            }
            onAddAssertion={() => setAssertionOpen(true)}
          />
        ) : (
          <EmptyState title="No step selected" hint="Click a step in the middle column to edit it in the Inspector." />
        )}
      </Drawer>

      <AssertionPickerModal
        open={assertionOpen}
        anchorId={selectedId}
        apiBase={apiBaseOrigin}
        sessionId={sessionId.trim() || undefined}
        onInsert={insertAssertion}
        onClose={() => setAssertionOpen(false)}
      />
      <BuilderTour />

      {/* Header env select đồng bộ với EnvironmentsPanel (chung envId state). */}
      <Dialog open={showEnvs} onClose={() => setShowEnvs(false)} title="Environments" wide>
        <EnvironmentsPanel
          projectId={projectId}
          envs={environments}
          onChanged={() => void reloadEnvs(projectId).then(() => void reloadVariables(projectId))}
          onClose={() => setShowEnvs(false)}
        />
      </Dialog>

      {showRunModal && id ? (
        <RunModal
          testId={id}
          envs={environments}
          envId={envId || null}
          datasets={definition.datasets ?? []}
          projectId={projectId && projectId !== "demo" ? projectId : undefined}
          onClose={() => setShowRunModal(false)}
          onStarted={(runId) => {
            setShowRunModal(false);
            toast.push("success", `Run ${runId} created.`);
            nav(`/runs/${runId}`);
          }}
        />
      ) : null}
    </main>
  );
}

// ------------------------------------------------------------- autosave badge ---

/** Project resources menu (keeps the Builder toolbar to one row). */
function ProjectMenu({ projectId, nav }: { projectId: string; nav: (to: string) => void }) {
  const [open, setOpen] = useState(false);
  const items = [
    { to: `/projects/${projectId}/actions`, icon: "🔁", label: "Actions", hint: "Reusable actions / business keywords" },
    { to: `/projects/${projectId}/profiles`, icon: "👤", label: "Profiles", hint: "Auth profiles (storageState)" },
    { to: `/projects/${projectId}/files`, icon: "📁", label: "Files", hint: "File library for Upload steps" },
    { to: `/projects/${projectId}/schedules`, icon: "🕒", label: "Schedules", hint: "Cron schedules for suites/tests" },
    { to: `/projects/${projectId}/suites`, icon: "📦", label: "Suites", hint: "Group tests to run together" },
  ];
  return (
    <span className="relative">
      <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} title="Project resources">
        📁 Project ▾
      </Button>
      {open ? (
        <>
          <span className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <span role="menu" className="absolute left-0 z-20 mt-1 w-60 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
            {items.map((it) => (
              <button
                key={it.to}
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-slate-50"
                onClick={() => { setOpen(false); nav(it.to); }}
              >
                <span aria-hidden className="text-base">{it.icon}</span>
                <span>
                  <span className="block text-sm font-medium text-slate-800">{it.label}</span>
                  <span className="block text-xs text-slate-500">{it.hint}</span>
                </span>
              </button>
            ))}
          </span>
        </>
      ) : null}
    </span>
  );
}

function TagsEditor({ disabled, onAdd }: { disabled?: boolean; onAdd: (tag: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  if (!open) {
    return (
      <button
        type="button"
        className="text-xs text-slate-500 hover:text-indigo-700 hover:underline"
        disabled={disabled}
        title={disabled ? "Offline — start the server to save tags" : "Add tag (autosave PATCH definition.tags)"}
        onClick={() => setOpen(true)}
      >
        + Tag
      </button>
    );
  }
  return (
    <form
      className="inline-flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        const t = value.trim().replace(/\s+/g, "-").slice(0, 32);
        if (!t) return;
        onAdd(t);
        setValue("");
        setOpen(false);
      }}
    >
      <Input
        autoFocus
        aria-label="New tag"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="tag…"
        className="h-6 w-24 text-xs"
      />
      <Button size="sm" type="submit" variant="outline" className="h-6 px-2 text-xs">
        Add
      </Button>
      <button
        type="button"
        aria-label="Cancel add tag"
        className="text-xs text-slate-400 hover:text-slate-700"
        onClick={() => {
          setOpen(false);
          setValue("");
        }}
      >
        ×
      </button>
    </form>
  );
}

function AutosaveBadge({
  state,
  dirty,
  error,
  offline,
}: {
  state: SaveState;
  dirty: boolean;
  error: string;
  offline: boolean;
}) {
  if (offline) return <Badge tone="amber">Offline — not saved to server</Badge>;
  if (state === "saving" || dirty) return <Badge tone="indigo">Saving…</Badge>;
  if (state === "error") return <Badge tone="red" title={error}>Save error — keep editing to retry</Badge>;
  return <Badge tone="green">Saved</Badge>;
}

/** Stability stamp + rubric at a glance. Check runs the gate (minutes) — needs an environment. */
function StabilityBadge({ testId, envId, offline, version }: { testId: string; envId: string; offline: boolean; version: string }) {
  const toast = useToast();
  const [stamp, setStamp] = useState<{ stable: boolean; stableRuns: number } | null>(null);
  const [score, setScore] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (offline) return;
    let live = true;
    void api.getStability(testId).then((s) => { if (live) setStamp({ stable: s.stable, stableRuns: s.stableRuns }); }).catch(() => undefined);
    void api.getRubric(testId).then((r) => { if (live) setScore(r.score); }).catch(() => undefined);
    return () => { live = false; };
  }, [testId, offline, version]);
  if (offline) return null;
  return (
    <span className="inline-flex items-center gap-1">
      {stamp ? (
        stamp.stable
          ? <Badge tone="green" title={`Passed ${stamp.stableRuns}/${stamp.stableRuns} consecutive runs. Any edit clears the stamp.`}>Stable {stamp.stableRuns}/{stamp.stableRuns}</Badge>
          : <Badge tone="slate" title="Not stamped — run the stability gate (3 consecutive passes) to certify this definition.">Not stable</Badge>
      ) : null}
      {score !== null ? <Badge tone="slate" title="Recording-quality rubric (stable locators, backups, no hard sleeps, assertions, names)">Rubric {score}/100</Badge> : null}
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !envId}
        title={envId ? "Run 3 consecutive passes (takes minutes) — stamps the definition stable on 3/3" : "Select an environment first"}
        onClick={() => {
          if (!envId) { toast.push("error", "Select an environment first."); return; }
          setBusy(true);
          void api.checkStability(testId, { environmentId: envId, runs: 3 }).then((v) => {
            setStamp({ stable: v.stable, stableRuns: v.stable ? v.total : 0 });
            toast.push(v.stable ? "success" : "error", v.stable ? `Stable ${v.passed}/${v.total} — stamp set.` : `Unstable: ${v.passed}/${v.total} passed. Inspect the runs.`);
          }).catch((e) => toast.push("error", e instanceof ApiError ? e.message : "Stability check failed")).finally(() => setBusy(false));
        }}
      >
        {busy ? "Checking…" : "Check 3×"}
      </Button>
    </span>
  );
}

// --------------------------------------------------------------- variables ---

function VariablesEditor({
  variables,
  onChange,
}: {
  variables: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const entries = Object.entries(variables);
  return (
    <div className="space-y-2">
      {entries.length === 0 ? (
        <p className="text-xs text-slate-500">
          No variables yet. Reference them in step values like <code>{"{{EMAIL}}"}</code>.
        </p>
      ) : (
        <ul className="space-y-1">
          {entries.map(([k, v]) => (
            <li key={k} className="flex items-center gap-2 text-sm">
              <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-semibold">{k}</code>
              <Input
                value={v}
                aria-label={`Variable ${k}`}
                onChange={(e) => onChange({ ...variables, [k]: e.target.value })}
                className="h-7 max-w-xs"
              />
              <button
                aria-label={`Delete variable ${k}`}
                className="text-xs text-red-600 hover:underline"
                onClick={() => {
                  const next = { ...variables };
                  delete next[k];
                  onChange(next);
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!key.trim()) return;
          onChange({ ...variables, [key.trim()]: value });
          setKey("");
          setValue("");
        }}
      >
        <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="KEY" className="h-7 max-w-40" />
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" className="h-7 max-w-xs" />
        <Button size="sm" type="submit" variant="outline">
          Add
        </Button>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------- runs ---

function RunsPanel({ testId }: { testId: string }) {
  const [runs, setRuns] = useState<{ id: string; status: string; browser: string }[] | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .listRuns(testId)
      .then((r) => {
        if (alive) setRuns(r);
      })
      .catch(() => {
        if (alive) setRuns([]);
      });
    return () => {
      alive = false;
    };
  }, [testId]);
  if (runs === null) return <Skeleton className="h-10" />;
  if (runs.length === 0)
    return <p className="text-xs text-slate-500">No runs yet. Select an environment, then click Run.</p>;
  return (
    <DataTable<{ id: string; status: string; browser: string }>
      caption="Runs for this test"
      emptyText="No runs yet."
      rows={runs}
      columns={[
        {
          key: "status",
          header: "Status",
          render: (r) => (
            <Badge tone={r.status === "failed" ? "red" : r.status === "passed" ? "green" : "slate"}>
              {r.status}
            </Badge>
          ),
        },
        {
          key: "id",
          header: "Run",
          render: (r) => (
            <Link to={`/runs/${r.id}`} className="font-mono text-indigo-700 hover:underline">
              <code>{r.id}</code>
            </Link>
          ),
        },
        { key: "browser", header: "Browser" },
      ]}
    />
  );
}
