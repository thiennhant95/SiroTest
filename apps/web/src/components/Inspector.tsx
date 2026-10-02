import { useState } from "react";
import { Advanced, Badge, Button, Checkbox, Field, Input, Select, Textarea } from "./ui";
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
  apiBase?: string;  /** Test id for POST /tests/:id/locator/test (falls back to sessionId). */
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
 * Advanced. waitForTimeout is labelled "Chỉ khi cần".
 *
 * Locator wiring (05-locator): LocatorBadge readable + Test locator
 * (0/1/N via testLocator) + Pick from page (setPickMode + WS
 * recorder.locatorPicked fills primary+alternatives) + Add assertion
 * (parent AssertionPickerModal, before/after anchor).
 */
export function Inspector({ step, onPatch, apiBase, testId, sessionId, testResult, onTestResult, onAddAssertion, testTimeoutMs, projectTimeoutMs }: { step: BuilderStep; onPatch: Patch } & InspectorExtraProps) {
  const meta = STEP_META[step.type];
  const set = (k: string, v: unknown) => onPatch({ [k]: v } as Partial<BuilderStep>);
  const blocked = !!testResult && !testResult.canSave;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">
          {meta?.icon} {meta?.label ?? step.type}
        </h3>
        <p className="text-[11px] text-slate-500">
          <code>{step.type}</code> · id <code>{step.id}</code>
        </p>
      </div>

      {blocked ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          Locator matches 0 elements — this step cannot be saved as healthy. Refine the locator, then Test again.
        </p>
      ) : null}

      <Field label="Step name (hiển thị trên StepCard)">
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

      <StepFields step={step} set={set} />

      {onAddAssertion ? (
        <Button size="sm" variant="outline" onClick={onAddAssertion}>
          + Add assertion (before/after this step)
        </Button>
      ) : null}

      {step.type === "waitForTimeout" ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          ⏱ <strong>Chỉ khi cần</strong> — fixed wait dễ gây flaky. Ưu tiên “Wait for
          element” (theo trạng thái visible/attached) hoặc “Wait for URL”.
        </p>
      ) : null}

      <Advanced title="Step options">
        <Field label="Timeout (ms, để trống = mặc định)">
          <Input
            type="number"
            min={0}
            value={step.timeoutMs ?? ""}
            placeholder="vd 10000"
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
  const label = { step: "Step override", test: "Test override", project: "Project default", default: "Mặc định 30s" }[source];
  return (
    <p className="mt-1 text-[11px] text-slate-500" title={`Effective timeout ${effective}ms from ${source}`}>
      Nguồn timeout: <Badge>{label}</Badge> <span className="text-slate-400">· hiệu lực {effective}ms</span>
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
        <Field label="Recorder session (để Pick / Test trên live page)">
          <Input
            value={manualSessionId}
            placeholder="vd 3fa85f64… (lấy ở Record)"
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
          <option value="role">Role (khuyên dùng)</option>
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
          <Field label="Accessible name (vd Login, Email)">
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

function StepFields({ step, set }: { step: BuilderStep; set: (k: string, v: unknown) => void }) {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (step.type) {
    case "goto":
      return (
        <Field label="URL" hint="Tương đối (/login) hoặc tuyệt đối">
          <Input value={str(step.url)} onChange={(e) => set("url", e.target.value)} placeholder="/login" />
        </Field>
      );
    case "fill":
      return (
        <>
          <Field label="Value" hint='Hỗ trợ biến {{TEN_BIEN}} (tab Variables)'>
            <Input
              type={(step as { sensitive?: boolean }).sensitive ? "password" : "text"}
              value={str(step.value)}
              onChange={(e) => set("value", e.target.value)}
              placeholder="tester@example.com"
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <Checkbox
              checked={!!(step as { sensitive?: boolean }).sensitive}
              onChange={(e) => set("sensitive", e.target.checked || undefined)}
            />
            Sensitive (mật khẩu — che khi hiển thị)
          </label>
        </>
      );
    case "select":
      return (
        <Field label="Option value">
          <Input value={str(step.value)} onChange={(e) => set("value", e.target.value)} />
        </Field>
      );
    case "press":
      return (
        <Field label="Key" hint="vd Enter, Tab, Escape, ArrowDown">
          <Input value={str(step.key) || "Enter"} onChange={(e) => set("key", e.target.value)} />
        </Field>
      );
    case "assertText":
    case "assertContainsText":
    case "assertValue":
      return (
        <Field label="Expected">
          <Input value={str(step.expected)} onChange={(e) => set("expected", e.target.value)} />
        </Field>
      );
    case "assertTitle":
      return (
        <Field label="Expected title">
          <Input value={str(step.expected)} onChange={(e) => set("expected", e.target.value)} />
        </Field>
      );
    case "assertURL":
      return (
        <>
          <Field label="Expected URL">
            <Input value={str(step.expected)} onChange={(e) => set("expected", e.target.value)} placeholder="**/dashboard" />
          </Field>
          <Field label="Pattern (regex, thay cho expected)">
            <Input value={str(step.pattern)} onChange={(e) => set("pattern", e.target.value || undefined)} />
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
          <Field label="Pattern (thay cho URL)">
            <Input value={str(step.pattern)} onChange={(e) => set("pattern", e.target.value || undefined)} />
          </Field>
        </>
      );
    case "screenshot":
      return (
        <>
          <Field label="Screenshot name (tùy chọn)">
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
    default:
      return null;
  }
}
