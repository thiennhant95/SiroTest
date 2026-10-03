/**
 * Builder — step list + Inspector shell (Day 5-6).
 * Add/edit/reorder/disable/duplicate/delete + locator editor/picker +
 * assertion picker (flow B) + autosave draft with Saving/Saved/Error state.
 */
import { useEffect, useMemo, useState } from "react";
import {
  bearsLocator,
  type BuilderStep,
  type StepTestResult,
} from "../builder/types";
import {
  newStepId,
  sampleLoginSteps,
  toDefinitionSteps,
} from "../builder/sampleSteps";
import { authHeaders } from "../lib/api";
import { LocatorBadge } from "./LocatorBadge";
import { StepInspector } from "./StepInspector";
import {
  AssertionPickerModal,
  type InsertPosition,
} from "./AssertionPickerModal";

type SaveState = "Saved" | "Saving" | "Error" | "Unsaved" | "No test selected";

export function Builder(): JSX.Element {
  const [apiBase, setApiBase] = useState("http://localhost:3001");
  const [testId, setTestId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [steps, setSteps] = useState<BuilderStep[]>(() => sampleLoginSteps());
  const [selectedId, setSelectedId] = useState<string>("s4");
  const [results, setResults] = useState<Record<string, StepTestResult | null>>({});
  const [assertionOpen, setAssertionOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("No test selected");
  const [saveError, setSaveError] = useState<string | null>(null);

  const selected = steps.find((s) => s.id === selectedId) ?? steps[0];

  const unhealthy = useMemo(
    () => steps.filter((s) => results[s.id] && !results[s.id]!.canSave),
    [steps, results],
  );

  function patchStep(id: string, patch: Partial<BuilderStep>): void {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    setSaveState(testId ? "Unsaved" : "No test selected");
  }

  function insertAssertion(step: BuilderStep, anchorId: string, position: InsertPosition): void {
    setSteps((prev) => {
      const idx = prev.findIndex((s) => s.id === anchorId);
      if (idx < 0) return [...prev, step];
      const at = position === "before" ? idx : idx + 1;
      return [...prev.slice(0, at), step, ...prev.slice(at)];
    });
    setSelectedId(step.id);
    setSaveState(testId ? "Unsaved" : "No test selected");
  }

  function move(id: string, dir: -1 | 1): void {
    setSteps((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      const j = idx + dir;
      if (idx < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      const [s] = next.splice(idx, 1);
      next.splice(j, 0, s!);
      return next;
    });
  }

  function duplicate(id: string): void {
    setSteps((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      if (idx < 0) return prev;
      const src = prev[idx]!;
      const copy: BuilderStep = { ...src, id: newStepId("s"), name: `${src.name ?? src.type} (copy)` };
      return [...prev.slice(0, idx + 1), copy, ...prev.slice(idx + 1)];
    });
  }

  function remove(id: string): void {
    setSteps((prev) => prev.filter((s) => s.id !== id));
    setResults((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  // Autosave draft (visual-builder.md "Unsaved changes"); runs use the last
  // persisted revision, so the state is always explicit.
  useEffect(() => {
    if (!testId) {
      setSaveState("No test selected");
      return;
    }
    if (saveState !== "Unsaved") return;
    setSaveState("Saving");
    const t = setTimeout(() => {
      void (async () => {
        try {
          const base = apiBase.replace(/\/$/, "");
          const res = await fetch(`${base}/tests/${testId}`, {
            method: "PATCH",
            headers: authHeaders(),
            body: JSON.stringify({
              definitionJson: {
                schemaVersion: "1.0",
                id: testId,
                name: "builder draft",
                browser: "chromium",
                steps: toDefinitionSteps(steps),
              },
            }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
          setSaveState("Saved");
          setSaveError(null);
        } catch (e) {
          setSaveState("Error");
          setSaveError(e instanceof Error ? e.message : String(e));
        }
      })();
    }, 1200);
    return () => clearTimeout(t);
    // steps/testId/apiBase drive autosave; saveState gates re-entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, testId, apiBase, saveState === "Unsaved"]);

  return (
    <div>
      <section
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "end",
          marginBottom: 12,
          fontSize: 13,
        }}
      >
        <label>
          API base{" "}
          <input value={apiBase} onChange={(e) => setApiBase(e.target.value)} size={26} />
        </label>
        <label>
          Test ID{" "}
          <input
            value={testId}
            onChange={(e) => {
              setTestId(e.target.value);
              setSaveState(e.target.value ? "Unsaved" : "No test selected");
            }}
            placeholder="(optional — enables Test locator + autosave)"
            size={26}
          />
        </label>
        <label>
          Recorder session{" "}
          <input
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            placeholder="(optional — enables pick from live page)"
            size={26}
          />
        </label>
        <span aria-live="polite">
          Draft: <strong>{saveState}</strong>
          {saveState === "Error" && saveError && ` — ${saveError}`}
        </span>
      </section>

      {unhealthy.length > 0 && (
        <div
          role="alert"
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            borderRadius: 6,
            padding: "8px 10px",
            fontSize: 13,
            marginBottom: 12,
          }}
        >
          {unhealthy.length} step(s) match 0 elements and cannot be saved as
          healthy: {unhealthy.map((s) => s.name ?? s.type).join(", ")}.
        </div>
      )}

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <section style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <button type="button" onClick={() => setAssertionOpen(true)} disabled={!selected}>
              Add assertion
            </button>
          </div>
          <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {steps.map((s, i) => {
              const r = results[s.id];
              return (
                <li
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  style={{
                    border: "1px solid #e2e8f0",
                    borderLeft: s.id === selected?.id ? "4px solid #0284c7" : "1px solid #e2e8f0",
                    opacity: s.enabled ? 1 : 0.55,
                    borderRadius: 8,
                    padding: "8px 10px",
                    marginBottom: 8,
                    cursor: "pointer",
                    background: "#fff",
                  }}
                >
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ color: "#64748b", fontSize: 12 }}>#{i + 1}</span>
                    <code style={{ fontSize: 12 }}>{s.type}</code>
                    <strong style={{ fontSize: 13 }}>{s.name ?? ""}</strong>
                    {r && !r.canSave && <span title="0 matches" style={{ color: "#dc2626" }}>●</span>}
                    {r && r.status === "ambiguous" && (
                      <span title={r.warning ?? r.message} style={{ color: "#d97706" }}>▲</span>
                    )}
                  </div>
                  {bearsLocator(s.type) && (
                    <div style={{ marginTop: 4 }}>
                      <LocatorBadge
                        primary={s.target?.primary}
                        alternatives={s.target?.alternatives}
                        compact
                      />
                    </div>
                  )}
                  <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button type="button" onClick={(e) => { e.stopPropagation(); move(s.id, -1); }}>↑</button>
                    <button type="button" onClick={(e) => { e.stopPropagation(); move(s.id, 1); }}>↓</button>
                    <button type="button" onClick={(e) => { e.stopPropagation(); duplicate(s.id); }}>Duplicate</button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        patchStep(s.id, { enabled: !s.enabled });
                      }}
                    >
                      {s.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(s.id);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        <section style={{ flex: 1, minWidth: 0 }}>
          {selected ? (
            <StepInspector
              step={selected}
              apiBase={apiBase}
              testId={testId || undefined}
              sessionId={sessionId || undefined}
              testResult={results[selected.id] ?? null}
              onChange={(patch) => patchStep(selected.id, patch)}
              onAddAssertion={() => setAssertionOpen(true)}
              onTestResult={(r) =>
                setResults((prev) => ({ ...prev, [selected.id]: r }))
              }
            />
          ) : (
            <p style={{ color: "#64748b" }}>No steps yet.</p>
          )}
        </section>
      </div>

      <AssertionPickerModal
        open={assertionOpen}
        anchorId={selected?.id ?? null}
        apiBase={apiBase}
        sessionId={sessionId || undefined}
        onInsert={insertAssertion}
        onClose={() => setAssertionOpen(false)}
      />
    </div>
  );
}
