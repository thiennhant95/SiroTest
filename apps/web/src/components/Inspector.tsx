import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Advanced, Badge, Button, Checkbox, Field, Input, Select, Textarea, useToast } from "./ui";
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
 * Advanced. waitForTimeout is labelled "Chỉ khi cần".
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
          {meta?.description ?? (step.type.startsWith("plugin:") ? "Step từ plugin server-side" : "Step chưa hỗ trợ trong palette")}
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

      <StepFields step={step} set={set} projectId={projectId} />

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
        <p className="font-mono text-[11px] text-slate-500">
          type <code>{step.type}</code> · id <code>{step.id}</code>
        </p>
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

function StepFields({ step, set, projectId }: { step: BuilderStep; set: (k: string, v: unknown) => void; projectId?: string }) {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (step.type) {
    case "callAction":
      return <CallActionFields step={step} set={set} projectId={projectId} />;
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
    case "upload":
      return <UploadFields step={step} set={set} projectId={projectId} />;
    case "download": {
      const url = str(step.url);
      const hasTarget = !!(step.target as { primary?: unknown } | undefined)?.primary;
      return (
        <div className="space-y-3">
          <Field label="URL trực tiếp (tùy chọn)" hint="Điền URL để tải trực tiếp, HOẶC dùng Target ở trên (click rồi chờ download).">
            <Input value={url} onChange={(e) => set("url", e.target.value || undefined)} placeholder="https://example.com/report.pdf" />
          </Field>
          <Field label="Save as (tên file gợi ý)" hint="vd report.pdf — lưu vào artifacts của run.">
            <Input value={str(step.saveAs)} onChange={(e) => set("saveAs", e.target.value || undefined)} placeholder="report.pdf" />
          </Field>
          {!url && !hasTarget ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Cần ít nhất một trong hai: URL trực tiếp hoặc Target để click. Compile sẽ báo lỗi
              explicit nếu thiếu cả hai.
            </p>
          ) : null}
        </div>
      );
    }
    case "newTab":
      return (
        <Field label="URL (tùy chọn)" hint="Để trống = tab trắng, các step sau dùng tab mới này.">
          <Input value={str(step.url)} onChange={(e) => set("url", e.target.value || undefined)} placeholder="https://example.com" />
        </Field>
      );
    case "closeTab":
      return (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          ⚠ Đóng tab hiện tại. Sẽ <strong>lỗi explicit</strong> nếu đây là tab cuối cùng —
          đảm bảo test đã mở tab mới trước đó.
        </p>
      );
    case "handleDialog": {
      const action = str(step.action) === "dismiss" ? "dismiss" : "accept";
      return (
        <div className="space-y-3">
          <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Xử lý <strong>một lần</strong> cho hộp thoại <em>kế tiếp</em> (alert/confirm/prompt).
            Đặt step này <strong>ngay trước</strong> step gây ra dialog.
          </p>
          <Field label="Action">
            <Select value={action} onChange={(e) => set("action", e.target.value)}>
              <option value="accept">Accept (OK)</option>
              <option value="dismiss">Dismiss (Cancel)</option>
            </Select>
          </Field>
          <Field label="Prompt text (chỉ cho prompt())" hint="Chữ nhập vào hộp prompt; alert/confirm bỏ qua.">
            <Input value={str(step.promptText)} onChange={(e) => set("promptText", e.target.value || undefined)} placeholder="vd Hello" />
          </Field>
        </div>
      );
    }
    case "apiRequest":
      return <ApiRequestFields step={step} set={set} />;
    case "visualCheck":
      return <VisualCheckFields step={step} set={set} />;
    default:
      if (typeof step.type === "string" && step.type.startsWith("plugin:")) {
        return <PluginStepFields step={step} set={set} />;
      }
      return (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          Step type <code>{step.type}</code> chưa được hỗ trợ trong Inspector — compile sẽ
          báo lỗi explicit. Xóa step này hoặc chọn type khác trong palette.
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
          setError(e instanceof ApiError ? e.message : "Không tải được actions");
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
      <Field label="Reusable action" hint="Business keyword — body steps inline lúc compile">
        {actions === null ? (
          <p className="text-xs text-slate-500">Đang tải actions…</p>
        ) : actions.length > 0 ? (
          <Select
            value={actionId}
            onChange={(e) => {
              set("actionId", e.target.value);
              // Switching actions resets arguments (params differ).
              set("arguments", {});
            }}
          >
            <option value="">— Chọn action —</option>
            {actions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.parameters.length} param{a.parameters.length === 1 ? "" : "s"}, {a.steps.length} steps)
              </option>
            ))}
          </Select>
        ) : (
          <Input
            value={actionId}
            placeholder="action id (vd action_xxxxxxxxxx)"
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
          Action <code>{actionId}</code> không có trong project này — compile sẽ báo lỗi
          explicit. Chọn lại action ở trên.
        </p>
      ) : null}
      {selected ? (
        <div className="space-y-2 rounded-md border border-slate-200 p-3">
          <p className="text-xs font-semibold text-slate-600">
            Arguments · {selected.parameters.length === 0 ? "action không có param" : null}
          </p>
          {selected.parameters.map((p) => (
            <Field
              key={p.name}
              label={`Argument ${p.name}`}
              hint={
                p.secret
                  ? `Bắt buộc {{BIEN}} — plaintext bị compiler từ chối. ${p.description ?? ""} ${p.default !== undefined ? `(mặc định: ${p.default})` : ""}`
                  : `${p.description ?? ""} ${p.default !== undefined ? `(mặc định: ${p.default})` : ""}`
              }
            >
              <span className="mb-1 flex gap-1">
                {p.secret ? <Badge tone="red">secret</Badge> : null}
                {p.default === undefined ? <Badge tone="amber">required</Badge> : null}
              </span>
              <Input
                type={p.secret ? "password" : "text"}
                value={args[p.name] ?? ""}
                placeholder={p.default ?? `{{BIEN}} hoặc giá trị cho ${p.name}`}
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
          setLoadError(e instanceof ApiError ? e.message : "Không tải được file library");
        }
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  async function uploadNew(file: File | undefined) {
    if (!file || !projectId || projectId === "demo") return;
    if (file.size > 10 * 1024 * 1024) {
      toast.push("error", "File quá lớn (tối đa 10 MB hiển thị).");
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
        reader.onerror = () => reject(new Error("Không đọc được file"));
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
      toast.push("success", `Đã tải “${created.name}” lên library.`);
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Upload thất bại");
    } finally {
      setUploading(false);
    }
  }

  const selected = files?.find((f) => f.id === fileId) ?? null;

  return (
    <div className="space-y-3">
      <Field label="File trong library" hint="setInputFiles vào ô Target ở trên.">
        {unsupported ? (
          <Input value={fileId} onChange={(e) => set("fileId", e.target.value)} placeholder="file id (backend chưa hỗ trợ library)" />
        ) : files === null ? (
          <p className="text-xs text-slate-500">Đang tải file library…</p>
        ) : files.length > 0 ? (
          <Select value={fileId} onChange={(e) => set("fileId", e.target.value || undefined)}>
            <option value="">— Chọn file —</option>
            {files.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} ({formatBytes(f.sizeBytes)})
              </option>
            ))}
          </Select>
        ) : (
          <Input value={fileId} onChange={(e) => set("fileId", e.target.value || undefined)} placeholder="file id (thư viện trống — tải mới bên dưới)" />
        )}
      </Field>
      {loadError ? <p className="text-xs text-red-600">{loadError}</p> : null}
      {unsupported ? (
        <p className="text-[11px] text-slate-500">Backend chưa hỗ trợ file library (404) — dán fileId thủ công, compile vẫn báo lỗi explicit nếu sai.</p>
      ) : null}
      {selected ? (
        <p className="text-[11px] text-slate-500">
          Đã chọn: <strong>{selected.name}</strong> · {formatBytes(selected.sizeBytes)}
          {selected.mimeType ? ` · ${selected.mimeType}` : null}
        </p>
      ) : fileId ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          File <code>{fileId}</code> không có trong library project này — compile sẽ báo lỗi explicit.
        </p>
      ) : null}
      {projectId && projectId !== "demo" && !unsupported ? (
        <div className="space-y-2 rounded-md border border-slate-200 p-3">
          <p className="text-xs font-semibold text-slate-600">Tải file mới lên library (tối đa 10 MB)</p>
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Tên hiển thị (để trống = tên file gốc)" />
          <input
            type="file"
            aria-label="Tải file mới"
            disabled={uploading}
            onChange={(e) => {
              void uploadNew(e.target.files?.[0]);
              e.target.value = "";
            }}
            className="text-xs"
          />
          {uploading ? <p className="text-xs text-slate-500">Đang tải lên…</p> : null}
          <p className="text-[11px] text-slate-500">
            <Link to={`/projects/${projectId}/files`} className="text-indigo-700 hover:underline">Quản lý files →</Link>
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

function ApiRequestFields({ step, set }: { step: BuilderStep; set: (k: string, v: unknown) => void }) {
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
        setHeaderError(`Dòng header thiếu dấu “:” — ${line.trim().slice(0, 40)}`);
        return;
      }
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (!k) {
        setHeaderError("Header key rỗng.");
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
      <Field label="URL" hint="Tuyệt đối hoặc {{BASE_URL}}/api/…">
        <Input value={str(step.url)} onChange={(e) => set("url", e.target.value)} placeholder="https://api.example.com/users" />
      </Field>
      <Field label="Headers (mỗi dòng Key: value)" hint="vd Authorization: Bearer {{TOKEN}}">
        <Textarea rows={3} value={headerText} onChange={(e) => onHeaders(e.target.value)} placeholder={"Content-Type: application/json"} />
      </Field>
      {headerError ? <p className="text-xs text-red-600">{headerError}</p> : null}
      <Field label="Body (tùy chọn)" hint="JSON/text thô — hỗ trợ {{VARIABLES}}.">
        <Textarea rows={4} value={str(step.body)} onChange={(e) => set("body", e.target.value || undefined)} placeholder='{"name":"qa"}' />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Expected status" hint="Sai status = fail explicit.">
          <Input
            type="number"
            min={100}
            max={599}
            value={typeof step.expectedStatus === "number" ? step.expectedStatus : ""}
            placeholder="200"
            onChange={(e) => set("expectedStatus", e.target.value === "" ? undefined : Number(e.target.value))}
          />
        </Field>
        <Field label="Save as (biến)" hint="Lưu response text để step sau dùng.">
          <Input value={saveAs} onChange={(e) => set("saveAs", e.target.value || undefined)} placeholder="API_RESULT" />
        </Field>
      </div>
      {!saveAsOk ? (
        <p className="text-xs text-red-600">Tên biến phải khớp /^[A-Za-z_][A-Za-z0-9_]*$/.</p>
      ) : null}
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
      <Field label="Baseline name" hint="Tên duy nhất trong test — lần chạy capture đầu tiên lưu baseline này.">
        <Input value={str(step.name)} placeholder="vd hero" onChange={(e) => set("name", e.target.value)} />
      </Field>
      {!str(step.name) ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Chưa đặt tên baseline — compile sẽ báo lỗi explicit (name bắt buộc).
        </p>
      ) : null}
      <Field label="Threshold (0–1)" hint="Tỉ lệ pixel khác cho phép — mặc định 0.05 (5%).">
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
        <p className="text-xs text-red-600">Threshold phải nằm trong 0–1.</p>
      ) : null}
      <p className="text-[11px] text-slate-500">
        Target ở trên là tùy chọn — để trống = so toàn trang. Xem/sửa baseline tại trang Visual
        regression của test.
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
        <p className="text-xs text-slate-500">Đang tải plugin metadata…</p>
      ) : meta === null || !schema ? (
        <>
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Không tìm thấy metadata cho <code>{step.type}</code> (plugin chưa load hoặc
            ALLOW_PLUGINS tắt) — nhập params JSON thủ công. Compile/run báo lỗi explicit
            (PLUGIN_NOT_FOUND) nếu plugin thiếu.
          </p>
          <Field label="Params (JSON)" hint='vd {"label":"Password","value":"{{LOGIN_PW}}"}'>
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
        <p className="text-xs text-slate-500">Plugin step này không khai báo param.</p>
      ) : (
        <div className="space-y-2 rounded-md border border-slate-200 p-3">
          <p className="text-xs font-semibold text-slate-600">Params</p>
          {Object.entries(properties).map(([name, prop]) => (
            <Field
              key={name}
              label={`Param ${name}`}
              hint={`${prop.description ?? ""} ${prop.default !== undefined ? `(mặc định: ${prop.default})` : ""}`.trim() || undefined}
            >
              <span className="mb-1 flex gap-1">
                {prop.secret ? <Badge tone="red">secret</Badge> : null}
                {required.has(name) ? <Badge tone="amber">required</Badge> : null}
              </span>
              <Input
                type={prop.secret ? "password" : "text"}
                value={params[name] ?? ""}
                placeholder={prop.secret ? "{{BIEN}} (bắt buộc — plaintext bị từ chối)" : (prop.default ?? `Giá trị cho ${name}`)}
                onChange={(e) => setParam(name, e.target.value)}
              />
            </Field>
          ))}
          {Object.keys(params).filter((k) => !(k in properties)).length > 0 ? (
            <p className="text-[11px] text-slate-500">
              Params thừa (không có trong schema):{" "}
              {Object.keys(params).filter((k) => !(k in properties)).join(", ")} — giữ lại khi
              compile, plugin tự quyết định.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
