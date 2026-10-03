/**
 * AiAssistantPage — P2 AI assistant (3 tabs). NEW file; App.tsx/BuilderPage.tsx untouched.
 *
 * WIRING CONTRACT (for a follow-up change owned by the UI agent):
 *   // apps/web/src/App.tsx (add ONE line, no other edits):
 *   import { AiAssistantPage } from "./pages/AiAssistantPage";
 *   <Route path="/projects/:id/ai" element={<RequireAuth><AiAssistantPage /></RequireAuth>} />
 *
 *   // Deep-link from BuilderPage (optional, no edits required here):
 *   // <AiAssistantPage testId={testId} onInsertSteps={(steps) => insertAtCursor(steps)} />
 *
 * PROPS CONTRACT:
 *   onInsertSteps?: (steps) => void — Builder passes a callback that inserts
 *     previewed steps at the cursor. When omitted, the "Chèn vào Builder"
 *     buttons render disabled with an explanatory tooltip (preview-only mode).
 *   testId?: string — pre-fills the cleanup tab (cleanup-by-test).
 *   runId?: string  — pre-fills the explain tab (explain-by-run).
 *   initialTab?: 'compose' | 'explain' | 'cleanup'.
 *
 * Every server response carries `engine: 'rules' | 'llm'` and is rendered as
 * a badge — the UI never presents rule-based output as LLM output.
 */
import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Tabs,
  Textarea,
} from "../components/ui";
import {
  aiApi,
  type AiStatus,
  type AiStep,
  type CleanupResponse,
  type ExplainResponse,
  type NlToStepsResponse,
} from "../api/ai";
import { ApiError } from "../lib/api";

export type AiTab = "compose" | "explain" | "cleanup";

export interface AiAssistantProps {
  onInsertSteps?: (steps: AiStep[]) => void;
  testId?: string;
  runId?: string;
  initialTab?: AiTab;
}

function EngineBadge({ engine }: { engine: string }) {
  return (
    <Badge tone={engine === "llm" ? "indigo" : "slate"} title={engine === "llm" ? "Sinh bởi LLM (có AI key)" : "Luật quyết định cục bộ (không có AI key) — không phải LLM"}>
      engine: {engine}
    </Badge>
  );
}

function errMsg(e: unknown): string {
  return e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : "Lỗi không xác định";
}

export function AiAssistantPage({ onInsertSteps, testId, runId, initialTab = "compose" }: AiAssistantProps) {
  const [tab, setTab] = useState<AiTab>(initialTab);
  const [status, setStatus] = useState<AiStatus | null>(null);

  useEffect(() => {
    let live = true;
    aiApi.status().then((s) => { if (live) setStatus(s); }).catch(() => { /* badge stays hidden */ });
    return () => { live = false; };
  }, []);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Trợ lý AI (P2 beta)</h1>
        {status ? <EngineBadge engine={status.engine} /> : null}
      </div>
      <Tabs<AiTab>
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "compose", label: "Soạn step từ câu chữ" },
          { value: "explain", label: "Giải thích lỗi" },
          { value: "cleanup", label: "Dọn recording" },
        ]}
      />
      {tab === "compose" ? <ComposeTab onInsertSteps={onInsertSteps} /> : null}
      {tab === "explain" ? <ExplainTab initialRunId={runId} /> : null}
      {tab === "cleanup" ? <CleanupTab testId={testId} onInsertSteps={onInsertSteps} /> : null}
    </div>
  );
}

/* ---------------------------------------------------------- compose --- */

function ComposeTab({ onInsertSteps }: { onInsertSteps?: (steps: AiStep[]) => void }) {
  const [text, setText] = useState('Mở trang https://example.com\nNhấn nút "Login"');
  const [result, setResult] = useState<NlToStepsResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true); setError("");
    try {
      setResult(await aiApi.nlToSteps(text));
    } catch (e) { setError(errMsg(e)); } finally { setLoading(false); }
  };

  return (
    <div className="space-y-3">
      <Field label="Mô tả test (tiếng Việt / English)" hint="Mỗi dòng một ý. Câu nào tool không hiểu sẽ nằm ở mục unparsed — không bịa step.">
        <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <Button onClick={run} disabled={loading || text.trim().length === 0}>
        {loading ? "Đang tạo…" : "Tạo steps"}
      </Button>
      {error ? <ErrorState message={error} onRetry={run} /> : null}
      {result ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <EngineBadge engine={result.engine} />
            <span className="text-xs text-slate-500">{result.steps.length} steps</span>
          </div>
          <DataTable<AiStep & { id: string }>
            caption="Preview steps (chưa lưu — bấm Chèn để đưa vào Builder)"
            columns={[
              { key: "type", header: "Type", render: (r) => <code className="text-xs">{r.type}</code> },
              { key: "name", header: "Tên", render: (r) => <span className="text-xs">{String(r.name ?? "—")}</span> },
              { key: "detail", header: "Chi tiết", render: (r) => <code className="text-[11px] text-slate-500">{JSON.stringify(r).slice(0, 160)}</code> },
            ]}
            rows={result.steps}
            emptyText="Không tạo được step nào — xem unparsed bên dưới."
          />
          {result.unparsed.length > 0 ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
              <p className="text-xs font-semibold text-amber-800">Không hiểu ({result.unparsed.length} câu — hãy diễn đạt lại):</p>
              <ul className="mt-1 list-disc pl-5 text-xs text-amber-900">
                {result.unparsed.map((u, i) => <li key={i}><code>{u}</code></li>)}
              </ul>
            </div>
          ) : null}
          <Button
            variant="secondary"
            disabled={!onInsertSteps || result.steps.length === 0}
            title={onInsertSteps ? "Chèn steps vào Builder" : "Chưa wire với Builder — xem contract ở đầu file (prop onInsertSteps)"}
            onClick={() => onInsertSteps?.(result.steps)}
          >
            Chèn vào Builder
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------- explain --- */

function ExplainTab({ initialRunId }: { initialRunId?: string }) {
  const [runId, setRunId] = useState(initialRunId ?? "");
  const [errorText, setErrorText] = useState("");
  const [stepType, setStepType] = useState("");
  const [result, setResult] = useState<ExplainResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true); setError("");
    try {
      setResult(await aiApi.explain({
        ...(runId.trim() ? { runId: runId.trim() } : {}),
        ...(errorText.trim() ? { errorSummary: errorText.trim() } : {}),
        ...(stepType.trim() ? { stepType: stepType.trim() } : {}),
      }));
    } catch (e) { setError(errMsg(e)); } finally { setLoading(false); }
  };

  const exp = result?.explanation ?? null;

  return (
    <div className="space-y-3">
      <Field label="Run ID (đọc lỗi từ run trong DB)" hint="Để trống nếu dán lỗi thủ công bên dưới.">
        <Input value={runId} onChange={(e) => setRunId(e.target.value)} placeholder="run_…" />
      </Field>
      <Field label="Hoặc dán error message">
        <Textarea rows={4} value={errorText} onChange={(e) => setErrorText(e.target.value)} placeholder="locator.click: Timeout 5000ms exceeded …" />
      </Field>
      <Field label="Step type (tùy chọn)">
        <Input value={stepType} onChange={(e) => setStepType(e.target.value)} placeholder="click" />
      </Field>
      <Button onClick={run} disabled={loading || (!runId.trim() && !errorText.trim())}>
        {loading ? "Đang phân tích…" : "Giải thích lỗi"}
      </Button>
      {error ? <ErrorState message={error} onRetry={run} /> : null}
      {result && exp ? (
        <div className="space-y-3 rounded-lg border border-slate-200 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <EngineBadge engine={result.engine} />
            <Badge tone={exp.category === "unknown" ? "amber" : "indigo"}>{exp.category}</Badge>
            <Badge tone={exp.confidence === "high" ? "green" : exp.confidence === "medium" ? "amber" : "slate"}>
              độ tin cậy: {exp.confidence}
            </Badge>
          </div>
          <p className="text-sm">{exp.summary}</p>
          <div>
            <p className="text-xs font-semibold">Nguyên nhân có thể:</p>
            <ul className="list-disc pl-5 text-xs">{exp.likelyCauses.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </div>
          <div>
            <p className="text-xs font-semibold">Gợi ý khắc phục:</p>
            <ul className="list-disc pl-5 text-xs">{exp.suggestedFixes.map((f, i) => <li key={i}>{f}</li>)}</ul>
          </div>
        </div>
      ) : result ? null : (
        <EmptyState title="Chưa có phân tích" hint="Nhập runId hoặc dán lỗi rồi bấm Giải thích lỗi." />
      )}
    </div>
  );
}

/* ---------------------------------------------------------- cleanup --- */

function CleanupTab({ testId, onInsertSteps }: { testId?: string; onInsertSteps?: (steps: AiStep[]) => void }) {
  const [tid, setTid] = useState(testId ?? "");
  const [rawJson, setRawJson] = useState("[\n  {\"id\": \"a\", \"type\": \"goto\", \"enabled\": true, \"url\": \"https://example.com\"}\n]");
  const [useTest, setUseTest] = useState(Boolean(testId));
  const [result, setResult] = useState<CleanupResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true); setError("");
    try {
      if (useTest) {
        if (!tid.trim()) throw new Error("Nhập testId.");
        setResult(await aiApi.cleanupByTest(tid.trim()));
      } else {
        const parsed = JSON.parse(rawJson) as unknown;
        if (!Array.isArray(parsed)) throw new Error("JSON phải là mảng steps.");
        setResult(await aiApi.cleanupBySteps(parsed));
      }
    } catch (e) { setError(errMsg(e)); } finally { setLoading(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        <Button variant={useTest ? "default" : "secondary"} size="sm" onClick={() => setUseTest(true)}>Theo testId</Button>
        <Button variant={!useTest ? "default" : "secondary"} size="sm" onClick={() => setUseTest(false)}>Dán steps JSON</Button>
      </div>
      {useTest ? (
        <Field label="Test ID" hint="Đọc steps từ definition đã lưu. Chỉ preview — KHÔNG tự ghi đè.">
          <Input value={tid} onChange={(e) => setTid(e.target.value)} placeholder="test_…" />
        </Field>
      ) : (
        <Field label="Raw steps JSON" hint="Mảng steps thô từ recorder.">
          <Textarea rows={6} value={rawJson} onChange={(e) => setRawJson(e.target.value)} />
        </Field>
      )}
      <Button onClick={run} disabled={loading}>{loading ? "Đang dọn…" : "Dọn recording"}</Button>
      {error ? <ErrorState message={error} onRetry={run} /> : null}
      {result ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <EngineBadge engine={result.engine} />
            <span className="text-xs text-slate-500">{result.steps.length} steps sau dọn · {result.changes.length} thay đổi</span>
          </div>
          <div className="rounded-lg border border-slate-200 p-3">
            <p className="text-xs font-semibold">Nhật ký biến đổi (review trước khi lưu):</p>
            <ul className="mt-1 space-y-1">
              {result.changes.map((c, i) => (
                <li key={i} className="text-xs">
                  <Badge tone={c.kind === "suggest-assertion" ? "green" : c.kind === "kept-unrecognized" ? "red" : "slate"}>{c.kind}</Badge>{" "}
                  <span>{c.description}</span>
                </li>
              ))}
            </ul>
          </div>
          <DataTable<AiStep & { id: string }>
            caption="Steps sau dọn (preview)"
            columns={[
              { key: "type", header: "Type", render: (r) => <code className="text-xs">{r.type}</code> },
              { key: "name", header: "Tên", render: (r) => <span className="text-xs">{String(r.name ?? "—")}</span> },
            ]}
            rows={result.steps}
            emptyText="Không còn step nào."
          />
          <Button
            variant="secondary"
            disabled={!onInsertSteps || result.steps.length === 0}
            title={onInsertSteps ? "Đưa steps đã dọn vào Builder (bạn vẫn phải Save)" : "Chưa wire với Builder — xem contract ở đầu file (prop onInsertSteps)"}
            onClick={() => onInsertSteps?.(result.steps)}
          >
            Đưa vào Builder
          </Button>
        </div>
      ) : null}
    </div>
  );
}
