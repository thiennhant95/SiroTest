import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Advanced, Badge, Button, Checkbox, Field, Input, Select, Textarea, useToast } from "./ui";
import { VariableInput } from "./VariableInput";
import { ApiError, api, isNotImplemented, type ActionRecord, type FileAsset } from "../lib/api";
import {
  STEP_META,
  locatorPreview,
  targetSummary,
  type BuilderStep,
  type LocatorCandidate,
  type LocatorSpec,
} from "../lib/steps";
import { LocatorBadge } from "./LocatorBadge";
import { LocatorTestPanel } from "./LocatorTestPanel";
import { LocatorPickerModal } from "./LocatorPickerModal";
import { apiBase as defaultApiBase } from "../lib/api";
import type { PickedLocator } from "../lib/recorderWs";
import type { LocatorCandidate as EngineCandidate } from "../lib/locator";
import type { StepTestResult } from "../builder/types";

type Patch = (patch: Partial<BuilderStep>) => void;

export interface InspectorExtraProps {
  /** Origin for testLocator/setPickMode (e.g. http://localhost:3001). Defaults from lib/api. */
  apiBase?: string;
  /** Project id — enables the callAction editor (list project actions). */
  projectId?: string;
  /** Test id for POST /tests/:id/locator/test (falls back to sessionId). */
  testId?: string;
  /** Recorder session for pick mode + session locator test fallback. */
  sessionId?: string;
  /** Last "Test locator" outcome; 0 matches blocks healthy save. */
  testResult?: StepTestResult | null;
  onTestResult?: (r: StepTestResult | null) => void;
  /** Opens the parent AssertionPickerModal anchored at this step. */
  onAddAssertion?: () => void;
  /** Timeout inheritance chain (runner-spec.md): Project → Test → Step. */
  testTimeoutMs?: number;
  projectTimeoutMs?: number;
}

/**
 * Inspector: fields change by step type. Locator-bearing steps show a
 * readable summary first ("Button “Login”"), raw strategy/JSON only in
 * Advanced. waitForTimeout is labelled "Only if needed".
 *
 * Locator wiring (05-locator): LocatorBadge readable + Test locator
 * (0/1/N via testLocator) + Pick from page (setPickMode + WS
 * recorder.locatorPicked fills primary+alternatives) + Add assertion
 * (parent AssertionPickerModal, before/after anchor).
 */
export function Inspector({ step, onPatch, apiBase, projectId, testId, sessionId, testResult, onTestResult, onAddAssertion, testTimeoutMs, projectTimeoutMs }: { step: BuilderStep; onPatch: Patch } & InspectorExtraProps) {
  const meta = STEP_META[step.type];
  const set = (k: string, v: unknown) => onPatch({ [k]: v } as Partial<BuilderStep>);
  const blocked = !!testResult && !testResult.canSave;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">
          {meta?.icon} {meta?.label ?? (step.type.startsWith("plugin:") ? "Custom step" : step.type)}
          {step.type.startsWith("plugin:") ? <Badge tone="indigo">plugin</Badge> : null}
        </h3>
        <p className="text-[11px] text-slate-500">
          {meta?.description ?? (step.type.startsWith("plugin:") ? "Server-side plugin step" : "Step not supported in the palette")}
        </p>
      </div>

      {blocked ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          Locator matches 0 elements — this step cannot be saved as healthy. Refine the locator, then Test again.
        </p>
      ) : null}

      <Field label="Step name (shown on StepCard)">
        <Input
          value={step.name ?? ""}
          placeholder={meta?.label ?? step.type}
          onChange={(e) => set("name", e.target.value || undefined)}
        />
      </Field>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <Checkbox
          checked={step.enabled}
          onChange={(e) => onPatch({ enabled: e.target.checked })}
        />
        Enabled
      </label>

      {meta?.hasTarget ? (
        <TargetEditor
          step={step}
          onPatch={onPatch}
          apiBase={apiBase}
          testId={testId}
          sessionId={sessionId}
          testResult={testResult}
          onTestResult={onTestResult}
          onAddAssertion={onAddAssertion}
        />
      ) : null}

      <StepFields step={step} set={set} projectId={projectId} />

      {onAddAssertion ? (
        <Button size="sm" variant="outline" onClick={onAddAssertion}>
          + Add assertion (before/after this step)
        </Button>
      ) : null}

      {step.type === "waitForTimeout" ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          ⏱ <strong>Only if needed</strong> — fixed waits tend to be flaky. Prefer “Wait for
          element” (visible/attached state) or “Wait for URL”.
        </p>
      ) : null}

      <Advanced title="Step options">
        <p className="font-mono text-[11px] text-slate-500">
          type <code>{step.type}</code> · id <code>{step.id}</code>
        </p>
        <Field label="Timeout (ms, empty = default)">
          <Input
            type="number"
            min={0}
            value={step.timeoutMs ?? ""}
            placeholder="e.g. 10000"
            onChange={(e) => set("timeoutMs", e.target.value === "" ? undefined : Number(e.target.value))}
          />
          <TimeoutSourceBadge
            stepTimeoutMs={step.timeoutMs}
            testTimeoutMs={testTimeoutMs}
            projectTimeoutMs={projectTimeoutMs}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <Checkbox
            checked={!!step.continueOnFailure}
            onChange={(e) => onPatch({ continueOnFailure: e.target.checked || undefined })}
          />
          Continue on failure
        </label>
        <Field label="Raw step JSON">
          <Textarea rows={8} readOnly value={JSON.stringify(step, null, 2)} />
        </Field>
      </Advanced>
    </div>
  );
}

// --------------------------------------------------------------- target ---

/**
 * Timeout inheritance badge (runner-spec.md): Project → Test → Step.
 * Mirrors runner `resolveStepTimeout` source so the UI always shows
 * which level the effective timeout came from.
 */
export function TimeoutSourceBadge({ stepTimeoutMs, testTimeoutMs, projectTimeoutMs }: {
  stepTimeoutMs?: number; testTimeoutMs?: number; projectTimeoutMs?: number;
}) {
  const valid = (v: number | undefined) => typeof v === "number" && Number.isFinite(v) && v > 0;
  const source = valid(stepTimeoutMs) ? "step" : valid(testTimeoutMs) ? "test" : valid(projectTimeoutMs) ? "project" : "default";
  const effective = valid(stepTimeoutMs) ? stepTimeoutMs : valid(testTimeoutMs) ? testTimeoutMs : valid(projectTimeoutMs) ? projectTimeoutMs : 30000;
  const label = { step: "Step override", test: "Test override", project: "Project default", default: "30s default" }[source];
  return (
    <p className="mt-1 text-[11px] text-slate-500" title={`Effective timeout ${effective}ms from ${source}`}>
      Timeout source: <Badge>{label}</Badge> <span className="text-slate-400">· effective {effective}ms</span>
    </p>
  );
}

function TargetEditor({
  step,
  onPatch,
  apiBase,
  testId,
  sessionId,
  onTestResult,
  onAddAssertion,
}: {
  step: BuilderStep;
  onPatch: Patch;
} & InspectorExtraProps) {
  const spec = (step.target as LocatorSpec | undefined) ?? {
    primary: { strategy: "role", role: "button", name: "" } as LocatorCandidate,
  };
  const primary = spec.primary;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [manualSessionId, setManualSessionId] = useState("");

  const resolvedApiBase = (apiBase ?? defaultApiBase.replace(/\/api\/v1$/, "")).replace(/\/$/, "");
  const effectiveSessionId = sessionId || manualSessionId.trim() || undefined;

  const setPrimary = (p: LocatorCandidate) => {
    onPatch({ target: { ...spec, primary: p } });
    // A changed locator invalidates the previous test outcome.
    onTestResult?.(null);
  };

  function applyPicked(picked: PickedLocator): void {
    onPatch({
      target: {
        ...spec,
        primary: picked.primary as unknown as LocatorCandidate,
        alternatives: picked.alternatives as unknown as LocatorCandidate[],
      },
    });
    onTestResult?.(null);
  }

  const enginePrimary = primary as unknown as EngineCandidate;
  const engineAlternatives = (spec.alternatives ?? []) as unknown as EngineCandidate[];

  return (
    <div className="space-y-3 rounded-md border border-slate-200 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-600">Target</span>
        <Badge tone="indigo">{targetSummary(spec)}</Badge>
      </div>

      {/* (1) Readable locator first — e.g. Button "Login". Exact expression lives in Advanced. */}
      <LocatorBadge primary={enginePrimary} alternatives={engineAlternatives} />

      {/* (3) Pick from page: sessionId + setPickMode + WS recorder.locatorPicked fills primary+alternatives. */}
      {!sessionId ? (
        <Field label="Recorder session (for Pick / Test on the live page)">
          <Input
            value={manualSessionId}
            placeholder="e.g. 3fa85f64... (from Record)"
            onChange={(e) => setManualSessionId(e.target.value)}
          />
        </Field>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
          Pick from page
        </Button>
        {onAddAssertion ? (
          <Button size="sm" variant="outline" onClick={onAddAssertion}>
            Add assertion
          </Button>
        ) : null}
      </div>

      {/* (2) Test locator: 0/1/N + warning; 0 matches blocks healthy save via onTestResult. */}
      <LocatorTestPanel
        candidate={enginePrimary}
        stepType={step.type}
        apiBase={resolvedApiBase}
        testId={testId}
        sessionId={effectiveSessionId}
        onResult={onTestResult}
      />

      <Field label="Locator strategy">
        <Select
          value={primary.strategy}
          onChange={(e) => {
            const s = e.target.value as LocatorCandidate["strategy"];
            if (s === "role") setPrimary({ strategy: s, role: "button", name: "" });
            else setPrimary({ strategy: s, value: "" });
          }}
        >
          <option value="role">Role (recommended)</option>
          <option value="label">Label</option>
          <option value="placeholder">Placeholder</option>
          <option value="testId">Test ID</option>
          <option value="text">Text</option>
          <option value="css">CSS</option>
          <option value="xpath">XPath</option>
        </Select>
      </Field>

      {primary.strategy === "role" ? (
        <>
          <Field label="Role">
            <Select
              value={primary.role ?? "button"}
              onChange={(e) => setPrimary({ ...primary, role: e.target.value })}
            >
              {["button", "link", "textbox", "heading", "checkbox", "combobox", "listbox", "option", "radio", "switch", "tab", "img", "dialog"].map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </Select>
          </Field>
          <Field label="Accessible name (e.g. Login, Email)">
            <Input
              value={primary.name ?? ""}
              placeholder="Login"
              onChange={(e) => setPrimary({ ...primary, name: e.target.value })}
            />
          </Field>
        </>
      ) : (
        <Field label="Value">
          <Input
            value={String(primary.value ?? "")}
            placeholder={primary.strategy === "css" ? "button.login" : "Login"}
            onChange={(e) => setPrimary({ ...primary, value: e.target.value })}
          />
        </Field>
      )}

      <Advanced title="Locator advanced">
        <p className="font-mono text-[11px] text-slate-600">{locatorPreview(spec)}</p>
        <Field label="Locator JSON">
          <Textarea
            rows={5}
            value={JSON.stringify(spec, null, 2)}
            onChange={(e) => {
              try {
                onPatch({ target: JSON.parse(e.target.value) as LocatorSpec });
                onTestResult?.(null);
              } catch {
                /* ignore invalid JSON while typing */
              }
            }}
          />
        </Field>
      </Advanced>

      <LocatorPickerModal
        open={pickerOpen}
        apiBase={resolvedApiBase}
        sessionId={effectiveSessionId}
        onPicked={applyPicked}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}

// ----------------------------------------------------------- per-type fields ---

function StepFields({ step, set, projectId }: { step: BuilderStep; set: (k: string, v: unknown) => void; projectId?: string }) {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (step.type) {
    case "callAction":
      return <CallActionFields step={step} set={set} projectId={projectId} />;
    case "goto":
      return (
        <Field label="URL" hint="Relative (/login) or absolute">
          <VariableInput value={str(step.url)} onChange={(v) => set("url", v)} placeholder="{{BASE_URL}}/login" projectId={projectId} ariaLabel="URL" />
        </Field>
      );
    case "fill":
      return (
        <>
          <Field label="Value" hint="Pick variables with { } — secrets must be {{VARIABLES}}">
            <VariableInput
              type={(step as { sensitive?: boolean }).sensitive ? "password" : "text"}
              value={str(step.value)}
              onChange={(v) => set("value", v)}
              placeholder="tester@example.com"
              projectId={projectId}
              ariaLabel="Value"
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <Checkbox
              checked={!!(step as { sensitive?: boolean }).sensitive}
              onChange={(e) => set("sensitive", e.target.checked || undefined)}
            />
            Sensitive (password — masked when displayed)
          </label>
        </>
      );
    case "select":
      return (
        <Field label="Option value">
          <VariableInput value={str(step.value)} onChange={(v) => set("value", v)} projectId={projectId} ariaLabel="Option value" />
        </Field>
      );
    case "press":
      return (
        <Field label="Key" hint="e.g. Enter, Tab, Escape, ArrowDown">
          <Input value={str(step.key) || "Enter"} onChange={(e) => set("key", e.target.value)} />
        </Field>
      );
    case "assertText":
    case "assertContainsText":
    case "assertValue":
      return (
        <Field label="Expected">
          <VariableInput value={str(step.expected)} onChange={(v) => set("expected", v)} projectId={projectId} ariaLabel="Expected" />
        </Field>
      );
    case "assertTitle":
      return (
        <Field label="Expected title">
          <VariableInput value={str(step.expected)} onChange={(v) => set("expected", v)} projectId={projectId} ariaLabel="Expected title" />
        </Field>
      );
    case "assertURL":
      return (
        <>
          <Field label="Expected URL">
            <VariableInput value={str(step.expected)} onChange={(v) => set("expected", v)} placeholder="**/dashboard" projectId={projectId} ariaLabel="Expected URL" />
          </Field>
          <Field label="Pattern (instead of expected)" hint="Glob supported: * matches one path segment, ** matches everything. E.g. **/login** — do not mix {{VARIABLES}} with *.">
            <Input value={str(step.pattern)} onChange={(e) => set("pattern", e.target.value || undefined)} placeholder="**/dashboard" />
          </Field>
        </>
      );
    case "waitForElement":
      return (
        <Field label="State">
          <Select value={str(step.state) || "visible"} onChange={(e) => set("state", e.target.value)}>
            <option value="visible">visible</option>
            <option value="hidden">hidden</option>
            <option value="attached">attached</option>
            <option value="detached">detached</option>
          </Select>
        </Field>
      );
    case "waitForTimeout":
      return (
        <Field label="Milliseconds">
          <Input
            type="number"
            min={0}
            value={Number(step.milliseconds ?? 0)}
            onChange={(e) => set("milliseconds", Number(e.target.value))}
          />
        </Field>
      );
    case "waitForURL":
      return (
        <>
          <Field label="URL">
            <Input value={str(step.url)} onChange={(e) => set("url", e.target.value)} />
          </Field>
          <Field label="Pattern (instead of URL)">
            <Input value={str(step.pattern)} onChange={(e) => set("pattern", e.target.value || undefined)} />
          </Field>
        </>
      );
    case "screenshot":
      return (
        <>
          <Field label="Screenshot name (optional)">
            <Input
              value={str((step as { screenshotName?: unknown }).screenshotName)}
              onChange={(e) => set("screenshotName", e.target.value || undefined)}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <Checkbox
              checked={!!step.fullPage}
              onChange={(e) => set("fullPage", e.target.checked || undefined)}
            />
            Full page
          </label>
        </>
      );
    case "upload":
      return <UploadFields step={step} set={set} projectId={projectId} />;
    case "download": {
      const url = str(step.url);
      const hasTarget = !!(step.target as { primary?: unknown } | undefined)?.primary;
      return (
        <div className="space-y-3">
          <Field label="Direct URL (optional)" hint="Enter a URL for direct download, OR use the Target above (click then wait for download).">
            <Input value={url} onChange={(e) => set("url", e.target.value || undefined)} placeholder="https://example.com/report.pdf" />
          </Field>
          <Field label="Save as (suggested file name)" hint="e.g. report.pdf — saved to the run artifacts.">
            <Input value={str(step.saveAs)} onChange={(e) => set("saveAs", e.target.value || undefined)} placeholder="report.pdf" />
          </Field>
          {!url && !hasTarget ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              At least one is required: a direct URL or a Target to click. Compilation fails
              with an explicit error if both are missing.
            </p>
          ) : null}
        </div>
      );
    }
    case "newTab":
      return (
        <Field label="URL (optional)" hint="Empty = blank tab; later steps use this new tab.">
          <Input value={str(step.url)} onChange={(e) => set("url", e.target.value || undefined)} placeholder="https://example.com" />
        </Field>
      );
    case "closeTab":
      return (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          ⚠ Close the current tab. Fails with an <strong>explicit error</strong> if this is the last tab —
          make sure the test opened a new tab first.
        </p>
      );
    case "handleDialog": {
      const action = str(step.action) === "dismiss" ? "dismiss" : "accept";
      return (
        <div className="space-y-3">
          <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Handle the <strong>next</strong> dialog <em>once</em> (alert/confirm/prompt).
            Place this step <strong>immediately before</strong> the step that triggers the dialog.
          </p>
          <Field label="Action">
            <Select value={action} onChange={(e) => set("action", e.target.value)}>
              <option value="accept">Accept (OK)</option>
              <option value="dismiss">Dismiss (Cancel)</option>
            </Select>
          </Field>
          <Field label="Prompt text (prompt() only)" hint="Text entered into the prompt dialog; ignored for alert/confirm.">
            <Input value={str(step.promptText)} onChange={(e) => set("promptText", e.target.value || undefined)} placeholder="e.g. Hello" />
          </Field>
        </div>
      );
    }
    case "apiRequest":
      return <ApiRequestFields step={step} set={set} projectId={projectId} />;
    case "mockRoute":
      return <MockRouteFields step={step} set={set} projectId={projectId} />;
    case "axeCheck":
      return <AxeCheckFields step={step} set={set} />;
    case "visualCheck":
      return <VisualCheckFields step={step} set={set} />;
    default:
      if (typeof step.type === "string" && step.type.startsWith("plugin:")) {
        return <PluginStepFields step={step} set={set} />;
      }
      return (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          Step type <code>{step.type}</code> is not supported in the Inspector — compilation
          fails with an explicit error. Delete this step or pick another type from the palette.
        </p>
      );
  }
}

// ------------------------------------------------------- P1 callAction ---

/**
 * CallActionFields: pick a project reusable action + fill its arguments.
 * Required params (no default) are marked; secret params render as password
 * inputs. Values support {{VARIABLES}} (secret args MUST be {{VARIABLES}} —
 * the compiler rejects plaintext secrets explicitly).
 */
function CallActionFields({
  step,
  set,
  projectId,
}: {
  step: BuilderStep;
  set: (k: string, v: unknown) => void;
  projectId?: string;
}) {
  const [actions, setActions] = useState<ActionRecord[] | null>(null);
  const [error, setError] = useState("");
  const actionId = typeof step.actionId === "string" ? step.actionId : "";
  const args = (step.arguments as Record<string, string> | undefined) ?? {};

  useEffect(() => {
    if (!projectId || projectId === "demo") {
      setActions([]);
      return;
    }
    let alive = true;
    setActions(null);
    setError("");
    api
      .listActions(projectId)
      .then((list) => {
        if (alive) setActions(list);
      })
      .catch((e) => {
        if (alive) {
          setActions([]);
          setError(e instanceof ApiError ? e.message : "Failed to load actions");
        }
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  const selected = actions?.find((a) => a.id === actionId) ?? null;

  const setArg = (name: string, value: string) => {
    const next = { ...args };
    if (value === "") delete next[name];
    else next[name] = value;
    set("arguments", next);
  };

  return (
    <div className="space-y-3">
      <Field label="Reusable action" hint="Business keyword — body steps are inlined at compile time">
        {actions === null ? (
          <p className="text-xs text-slate-500">Loading actions…</p>
        ) : actions.length > 0 ? (
          <Select
            value={actionId}
            onChange={(e) => {
              set("actionId", e.target.value);
              // Switching actions resets arguments (params differ).
              set("arguments", {});
            }}
          >
            <option value="">— Select action —</option>
            {actions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.parameters.length} param{a.parameters.length === 1 ? "" : "s"}, {a.steps.length} steps)
              </option>
            ))}
          </Select>
        ) : (
          <Input
            value={actionId}
            placeholder="action id (e.g. action_xxxxxxxxxx)"
            onChange={(e) => set("actionId", e.target.value)}
          />
        )}
      </Field>
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
      {projectId && projectId !== "demo" ? (
        <p className="text-[11px] text-slate-500">
          <Link to={`/projects/${projectId}/actions`} className="text-indigo-700 hover:underline">
            Manage actions →
          </Link>
        </p>
      ) : null}
      {actionId && actions !== null && !selected ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Action <code>{actionId}</code> is not in this project — compilation fails with an
          explicit error. Select another action above.
        </p>
      ) : null}
      {selected ? (
        <div className="space-y-2 rounded-md border border-slate-200 p-3">
          <p className="text-xs font-semibold text-slate-600">
            Arguments · {selected.parameters.length === 0 ? "action has no params" : null}
          </p>
          {selected.parameters.map((p) => (
            <Field
              key={p.name}
              label={`Argument ${p.name}`}
              hint={
                p.secret
                  ? `Requires {{VARIABLE}} — plaintext is rejected by the compiler. ${p.description ?? ""} ${p.default !== undefined ? `(default: ${p.default})` : ""}`
                  : `${p.description ?? ""} ${p.default !== undefined ? `(default: ${p.default})` : ""}`
              }
            >
              <span className="mb-1 flex gap-1">
                {p.secret ? <Badge tone="red">secret</Badge> : null}
                {p.default === undefined ? <Badge tone="amber">required</Badge> : null}
              </span>
              <Input
                type={p.secret ? "password" : "text"}
                value={args[p.name] ?? ""}
                placeholder={p.default ?? `{{VARIABLE}} or value for ${p.name}`}
                onChange={(e) => setArg(p.name, e.target.value)}
              />
            </Field>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------- P1 wave 2 upload ---

function UploadFields({ step, set, projectId }: { step: BuilderStep; set: (k: string, v: unknown) => void; projectId?: string }) {
  const toast = useToast();
  const fileId = typeof step.fileId === "string" ? step.fileId : "";
  const [files, setFiles] = useState<FileAsset[] | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [newName, setNewName] = useState("");
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!projectId || projectId === "demo") {
      setFiles([]);
      return;
    }
    let alive = true;
    setFiles(null);
    setUnsupported(false);
    setLoadError("");
    api
      .listFiles(projectId)
      .then((list) => {
        if (alive) setFiles(list);
      })
      .catch((e) => {
        if (!alive) return;
        if (isNotImplemented(e)) {
          setUnsupported(true);
          setFiles([]);
        } else {
          setFiles([]);
          setLoadError(e instanceof ApiError ? e.message : "Failed to load file library");
        }
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  async function uploadNew(file: File | undefined) {
    if (!file || !projectId || projectId === "demo") return;
    if (file.size > 10 * 1024 * 1024) {
      toast.push("error", "File too large (10 MB display limit).");
      return;
    }
    setUploading(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result ?? "");
          const comma = result.indexOf(",");
          resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(new Error("Could not read file"));
        reader.readAsDataURL(file);
      });
      const created = await api.uploadFile(projectId, {
        name: newName.trim() || file.name,
        contentBase64: base64,
        mimeType: file.type || undefined,
      });
      setFiles((prev) => (prev ? [created, ...prev] : [created]));
      set("fileId", created.id);
      setNewName("");
      toast.push("success", `Uploaded “${created.name}” to the library.`);
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  const selected = files?.find((f) => f.id === fileId) ?? null;

  return (
    <div className="space-y-3">
      <Field label="Library file" hint="setInputFiles into the Target field above.">
        {unsupported ? (
          <Input value={fileId} onChange={(e) => set("fileId", e.target.value)} placeholder="file id (backend does not support the library yet)" />
        ) : files === null ? (
          <p className="text-xs text-slate-500">Loading file library…</p>
        ) : files.length > 0 ? (
          <Select value={fileId} onChange={(e) => set("fileId", e.target.value || undefined)}>
            <option value="">— Select file —</option>
            {files.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} ({formatBytes(f.sizeBytes)})
              </option>
            ))}
          </Select>
        ) : (
          <Input value={fileId} onChange={(e) => set("fileId", e.target.value || undefined)} placeholder="file id (library is empty — upload a new one below)" />
        )}
      </Field>
      {loadError ? <p className="text-xs text-red-600">{loadError}</p> : null}
      {unsupported ? (
        <p className="text-[11px] text-slate-500">Backend does not support the file library yet (404) — paste a fileId manually; compilation still fails with an explicit error if it is wrong.</p>
      ) : null}
      {selected ? (
        <p className="text-[11px] text-slate-500">
          Selected: <strong>{selected.name}</strong> · {formatBytes(selected.sizeBytes)}
          {selected.mimeType ? ` · ${selected.mimeType}` : null}
        </p>
      ) : fileId ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          File <code>{fileId}</code> is not in this project's library — compilation fails with an explicit error.
        </p>
      ) : null}
      {projectId && projectId !== "demo" && !unsupported ? (
        <div className="space-y-2 rounded-md border border-slate-200 p-3">
          <p className="text-xs font-semibold text-slate-600">Upload a new file to the library (10 MB max)</p>
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Display name (empty = original file name)" />
          <input
            type="file"
            aria-label="Upload new file"
            disabled={uploading}
            onChange={(e) => {
              void uploadNew(e.target.files?.[0]);
              e.target.value = "";
            }}
            className="text-xs"
          />
          {uploading ? <p className="text-xs text-slate-500">Uploading…</p> : null}
          <p className="text-[11px] text-slate-500">
            <Link to={`/projects/${projectId}/files`} className="text-indigo-700 hover:underline">Manage files →</Link>
          </p>
        </div>
      ) : null}
    </div>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ------------------------------------------------------- P1 wave 2 API ---

function ApiRequestFields({ step, set, projectId }: { step: BuilderStep; set: (k: string, v: unknown) => void; projectId?: string }) {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const headers = (step.headers as Record<string, string> | undefined) ?? {};
  const headerText = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const [headerError, setHeaderError] = useState("");

  function onHeaders(text: string) {
    if (text.trim() === "") {
      setHeaderError("");
      set("headers", undefined);
      return;
    }
    const next: Record<string, string> = {};
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const idx = line.indexOf(":");
      if (idx < 0) {
        setHeaderError(`Header line is missing “:” — ${line.trim().slice(0, 40)}`);
        return;
      }
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (!k) {
        setHeaderError("Header key is empty.");
        return;
      }
      next[k] = v;
    }
    setHeaderError("");
    set("headers", next);
  }

  const saveAs = str(step.saveAs);
  const saveAsOk = saveAs === "" || /^[A-Za-z_][A-Za-z0-9_]*$/.test(saveAs);

  return (
    <div className="space-y-3">
      <Field label="Method">
        <Select value={str(step.method) || "GET"} onChange={(e) => set("method", e.target.value)}>
          {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </Select>
      </Field>
      <Field label="URL" hint="Absolute or {{BASE_URL}}/api/...">
        <VariableInput value={str(step.url)} onChange={(v) => set("url", v)} placeholder="https://api.example.com/users" projectId={projectId} ariaLabel="URL" />
      </Field>
      <Field label="Headers (one Key: value per line)" hint="e.g. Authorization: Bearer {{TOKEN}}">
        <Textarea rows={3} value={headerText} onChange={(e) => onHeaders(e.target.value)} placeholder={"Content-Type: application/json"} />
      </Field>
      {headerError ? <p className="text-xs text-red-600">{headerError}</p> : null}
      <Field label="Body (optional)" hint="Raw JSON/text — supports {{VARIABLES}}.">
        <Textarea rows={4} value={str(step.body)} onChange={(e) => set("body", e.target.value || undefined)} placeholder='{"name":"qa"}' />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Expected status" hint="A wrong status is an explicit failure.">
          <Input
            type="number"
            min={100}
            max={599}
            value={typeof step.expectedStatus === "number" ? step.expectedStatus : ""}
            placeholder="200"
            onChange={(e) => set("expectedStatus", e.target.value === "" ? undefined : Number(e.target.value))}
          />
        </Field>
        <Field label="Save as (variable)" hint="Save response text for later steps.">
          <Input value={saveAs} onChange={(e) => set("saveAs", e.target.value || undefined)} placeholder="API_RESULT" />
        </Field>
      </div>
      {!saveAsOk ? (
        <p className="text-xs text-red-600">Variable name must match /^[A-Za-z_][A-Za-z0-9_]*$/.</p>
      ) : null}
    </div>
  );
}

function MockRouteFields({ step, set, projectId }: { step: BuilderStep; set: (k: string, v: unknown) => void; projectId?: string }) {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const status = typeof step.status === "number" ? step.status : 200;
  const statusOk = Number.isInteger(status) && status >= 100 && status <= 599;
  return (
    <div className="space-y-3">
      <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        Intercept browser requests <strong>before</strong> the app sends them — place this step before the goto/click that triggers the request. A different method filter passes through to the real network.
      </p>
      <Field label="URL pattern (glob)" hint="e.g. {{BASE_URL}}/api/users/* — supports {{VARIABLES}}.">
        <VariableInput value={str(step.url)} onChange={(v) => set("url", v)} placeholder="**/api/users" projectId={projectId} ariaLabel="URL pattern" />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Method filter (optional)" hint="Empty = intercept all methods.">
          <Select
            value={str(step.method)}
            onChange={(e) => set("method", e.target.value === "" ? undefined : e.target.value)}
          >
            <option value="">(any)</option>
            {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </Select>
        </Field>
        <Field label="Response status">
          <Input
            type="number"
            min={100}
            max={599}
            value={status}
            onChange={(e) => set("status", e.target.value === "" ? undefined : Number(e.target.value))}
          />
        </Field>
      </div>
      {!statusOk ? (
        <p className="text-xs text-red-600">Status must be an integer from 100 to 599.</p>
      ) : null}
      <Field label="Content type (optional)">
        <Input value={str(step.contentType)} onChange={(e) => set("contentType", e.target.value || undefined)} placeholder="application/json" />
      </Field>
      <Field label="Response body (optional)" hint="Raw text — supports {{VARIABLES}}.">
        <Textarea rows={4} value={str(step.body)} onChange={(e) => set("body", e.target.value || undefined)} placeholder='{"error":"mocked"}' />
      </Field>
    </div>
  );
}

const AXE_IMPACTS = ["critical", "serious", "moderate", "minor"] as const;

function AxeCheckFields({ step, set }: { step: BuilderStep; set: (k: string, v: unknown) => void }) {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const inc = Array.isArray(step.includedImpacts) ? (step.includedImpacts as string[]) : ["critical", "serious"];
  const toggle = (imp: string) => {
    const next = inc.includes(imp) ? inc.filter((x) => x !== imp) : [...inc, imp];
    set("includedImpacts", next.length === 0 ? undefined : next);
  };
  return (
    <div className="space-y-3">
      <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
        Axe-core scan (WCAG 2.0/2.1 A+AA). Fails explicitly with rule ids at the selected levels. Place after the page is stable.
      </p>
      <Field label="CSS scope (optional)" hint="Empty = whole page.">
        <Input value={str(step.selector)} onChange={(e) => set("selector", e.target.value || undefined)} placeholder="main, #checkout-form" />
      </Field>
      <Field label="Fail on">
        <div className="flex flex-wrap gap-1.5">
          {AXE_IMPACTS.map((imp) => {
            const on = inc.includes(imp);
            return (
              <button
                key={imp}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => toggle(imp)}
                className={`rounded-md border px-2.5 py-1 text-[13px] transition-colors ${
                  on ? "border-indigo-600 bg-indigo-50 font-semibold text-indigo-700" : "border-slate-300 bg-white text-slate-600 hover:border-indigo-400"
                }`}
              >
                {imp}
              </button>
            );
          })}
        </div>
      </Field>
      <Field label="Skipped rules (optional)" hint="One accepted rule id per line, e.g. color-contrast.">
        <Textarea
          rows={2}
          value={Array.isArray(step.disableRules) ? (step.disableRules as string[]).join("\n") : ""}
          onChange={(e) => set("disableRules", e.target.value.trim() === "" ? undefined : e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))}
          placeholder={"color-contrast"}
        />
      </Field>
    </div>
  );
}

// ------------------------------------------------------- P2 visualCheck ---

/**
 * visualCheck: baseline name (required) + threshold 0–1 (default 0.05).
 * Target is OPTIONAL — empty means whole-viewport comparison (VisualCheckStep).
 */
function VisualCheckFields({ step, set }: { step: BuilderStep; set: (k: string, v: unknown) => void }) {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const threshold = typeof step.threshold === "number" ? step.threshold : 0.05;
  const outOfRange = !Number.isFinite(threshold) || threshold < 0 || threshold > 1;
  return (
    <div className="space-y-3">
      <Field label="Baseline name" hint="Unique name within the test — the first capture run saves this baseline.">
        <Input value={str(step.name)} placeholder="e.g. hero" onChange={(e) => set("name", e.target.value)} />
      </Field>
      {!str(step.name) ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Baseline name is missing — compilation fails with an explicit error (name is required).
        </p>
      ) : null}
      <Field label="Threshold (0–1)" hint="Allowed pixel difference ratio — default 0.05 (5%).">
        <Input
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={Number.isFinite(threshold) ? threshold : ""}
          onChange={(e) => set("threshold", e.target.value === "" ? undefined : Number(e.target.value))}
        />
      </Field>
      {outOfRange ? (
        <p className="text-xs text-red-600">Threshold must be between 0 and 1.</p>
      ) : null}
      <p className="text-[11px] text-slate-500">
        The Target above is optional — empty compares the whole page. View/edit baselines on the test's Visual
        regression page.
      </p>
    </div>
  );
}

// ------------------------------------------------------- P2 plugin:* ---

interface PluginStepSchema {
  required?: string[];
  properties?: Record<string, { type: string; description?: string; secret?: boolean; default?: string }>;
}

interface PluginListResponse {
  enabled: boolean;
  plugins: Array<{
    name: string;
    steps: Array<{ type: string; description?: string; schema?: PluginStepSchema }>;
  }>;
}

/**
 * Schema-driven form for `plugin:*` steps (mirrors CallActionFields):
 * required params are badged, secret params render as password inputs and
 * MUST be {{VARIABLES}} (server rejects plaintext at compile/run time).
 * Values live in `step.params`. Unknown plugin → manual JSON fallback.
 */
function PluginStepFields({ step, set }: { step: BuilderStep; set: (k: string, v: unknown) => void }) {
  const [meta, setMeta] = useState<{ description?: string; schema?: PluginStepSchema } | null | undefined>(undefined);
  const params = (step.params as Record<string, string> | undefined) ?? {};

  useEffect(() => {
    let alive = true;
    const base = (defaultApiBase.replace(/\/api\/v1$/, "")).replace(/\/$/, "");
    const headers: Record<string, string> = {};
    try {
      const token = localStorage.getItem("vv_token");
      if (token) headers.Authorization = `Bearer ${token}`;
      else headers["x-user-id"] = "dev-user";
    } catch {
      headers["x-user-id"] = "dev-user";
    }
    fetch(`${base}/api/v1/plugins`, { headers })
      .then((res) => {
        if (!alive) return;
        if (res.status === 404 || !res.ok) {
          setMeta(null);
          return;
        }
        return (res.json() as Promise<PluginListResponse>).then((data) => {
          if (!alive) return;
          const found = data.plugins.flatMap((p) => p.steps).find((s) => s.type === step.type) ?? null;
          setMeta(found ? { description: found.description, schema: found.schema } : null);
        });
      })
      .catch(() => {
        if (alive) setMeta(null);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.type]);

  const setParam = (name: string, value: string) => {
    const next = { ...params };
    if (value === "") delete next[name];
    else next[name] = value;
    set("params", next);
  };

  const schema = meta?.schema;
  const required = new Set(schema?.required ?? []);
  const properties = schema?.properties ?? {};

  return (
    <div className="space-y-3">
      {meta?.description ? (
        <p className="text-xs text-slate-600">{meta.description}</p>
      ) : null}
      {meta === undefined ? (
        <p className="text-xs text-slate-500">Loading plugin metadata…</p>
      ) : meta === null || !schema ? (
        <>
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            No metadata found for <code>{step.type}</code> (plugin not loaded or
            ALLOW_PLUGINS is off) — enter params JSON manually. Compile/run fails explicitly
            (PLUGIN_NOT_FOUND) if the plugin is missing.
          </p>
          <Field label="Params (JSON)" hint='e.g. {"label":"Password","value":"{{LOGIN_PW}}"}'>
            <Textarea
              rows={5}
              value={JSON.stringify(step.params ?? {}, null, 2)}
              onChange={(e) => {
                try {
                  set("params", JSON.parse(e.target.value) as Record<string, unknown>);
                } catch {
                  /* ignore invalid JSON while typing */
                }
              }}
            />
          </Field>
        </>
      ) : Object.keys(properties).length === 0 ? (
        <p className="text-xs text-slate-500">This plugin step declares no params.</p>
      ) : (
        <div className="space-y-2 rounded-md border border-slate-200 p-3">
          <p className="text-xs font-semibold text-slate-600">Params</p>
          {Object.entries(properties).map(([name, prop]) => (
            <Field
              key={name}
              label={`Param ${name}`}
              hint={`${prop.description ?? ""} ${prop.default !== undefined ? `(default: ${prop.default})` : ""}`.trim() || undefined}
            >
              <span className="mb-1 flex gap-1">
                {prop.secret ? <Badge tone="red">secret</Badge> : null}
                {required.has(name) ? <Badge tone="amber">required</Badge> : null}
              </span>
              <Input
                type={prop.secret ? "password" : "text"}
                value={params[name] ?? ""}
                placeholder={prop.secret ? "{{VARIABLE}} (required — plaintext is rejected)" : (prop.default ?? `Value for ${name}`)}
                onChange={(e) => setParam(name, e.target.value)}
              />
            </Field>
          ))}
          {Object.keys(params).filter((k) => !(k in properties)).length > 0 ? (
            <p className="text-[11px] text-slate-500">
              Extra params (not in schema):{" "}
              {Object.keys(params).filter((k) => !(k in properties)).join(", ")} — kept at
              compile time; the plugin decides how to handle them.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
