/**
 * explain-failure.ts — P2 "AI: failure explanation" (rule path + LLM prompt).
 *
 * Rule engine classifies a failure into one of
 * `locator-not-found | timeout | assert-mismatch | navigation | unknown`
 * and returns likely causes + concrete fixes aligned with user flow C
 * (01-product/user-flows.md: concise error + locator + elapsed timeout +
 * screenshot, Open Trace, Edit locator).
 *
 * With an LLM key, {@link explainFailure} sends a redacted summary through
 * {@link buildExplainPrompt} and coerces the reply into the same schema;
 * any parse failure falls back to the rule engine (engine then reports
 * `'rules'` honestly — never a fabricated LLM answer).
 */
import type { AIProvider } from "./provider.js";

export type FailureCategory =
  | "locator-not-found"
  | "timeout"
  | "assert-mismatch"
  | "navigation"
  | "unknown";

export interface FailureInput {
  /** Terse error text (already redacted + path-stripped by the server route). */
  errorSummary: string;
  stepType?: string;
  /** LocatorSpec or its string form (for hints about alternatives). */
  locator?: unknown;
  timeoutMs?: number;
  stepName?: string;
}

export interface FailureExplanation {
  category: FailureCategory;
  /** One-paragraph human summary (Vietnamese, plain language). */
  summary: string;
  likelyCauses: string[];
  suggestedFixes: string[];
  confidence: "low" | "medium" | "high";
}

const MAX_PROMPT_ERROR_CHARS = 4000;

function hasAlternatives(locator: unknown): boolean {
  if (!locator || typeof locator !== "object") return false;
  const alt = (locator as Record<string, unknown>).alternatives;
  return Array.isArray(alt) && alt.length > 0;
}

function locatorHint(input: FailureInput): string[] {
  if (input.locator === undefined) return [];
  return hasAlternatives(input.locator)
    ? ["Step này đã lưu sẵn locator dự phòng (alternatives) — vào Edit locator để thử từng candidate. (P0 không tự đổi locator khi chạy.)"]
    : ["Step này chưa có locator dự phòng — ghi lại bằng Record/pick-mode để lưu thêm candidates cho lần sửa sau."];
}

function timeoutHint(input: FailureInput): string[] {
  if (input.timeoutMs === undefined) return [];
  return [
    `Timeout hiệu lực là ${input.timeoutMs}ms — cân nhắc tăng timeout ở cấp step (ưu tiên) thay vì chờ cứng waitForTimeout.`,
  ];
}

function traceHint(): string {
  return "Mở screenshot/trace của run để xem trang ở trạng thái nào khi step thất bại (sai trang? loading chưa xong? popup che?).";
}

/** Pure deterministic classifier. Never throws on odd input. */
export function explainFailureRule(input: FailureInput): FailureExplanation {
  const err = (input.errorSummary ?? "").slice(0, MAX_PROMPT_ERROR_CHARS);
  const e = err.toLowerCase();
  const step = (input.stepType ?? "").toLowerCase();
  const isAssertStep = step.startsWith("assert");

  const assertMarkers =
    /expect\(|expect |assertionerror|assert|to(bevisible|behidden|havetext|containtext|havevalue|haveurl|havetitle|bechecked|beenabled|bedisabled)|expected.+received|actual.+expected|to equal|mismatch/i;
  const strictMarkers =
    /strict mode violation|resolved to 0|resolved to \d+ elements|locator.*did not resolve|waiting for.*locator|no element|element not found|element\(s\) not found|selector.*not found|target closed/i;
  const timeoutMarkers =
    /timeout.*exceeded|exceeded timeout|timeoutexpired|timed out after|waiting for.*timeout|test timeout/i;
  const navigationMarkers =
    /net::err|err_|navigation failed|navigation timeout|goto.*failed|certificate|ns_error|ssrf|blocked.*target|dns|econnrefused|enotfound/i;

  // Locator-gone check FIRST: an `expect()` error whose call log proves the
  // locator resolved to nothing is a missing element, not a wrong
  // expectation (same discriminator as runner isLocatorFailure).
  if (strictMarkers.test(e)) {
    const multi = /resolved to [2-9]|strict mode violation/i.test(err);
    return {
      category: "locator-not-found",
      summary: multi
        ? `Locator khớp NHIỀU element (strict-mode violation) — Playwright từ chối thao tác vì không xác định duy nhất.`
        : `Không tìm thấy element cho locator của step "${input.stepName ?? input.stepType ?? "?"}" trong thời gian chờ.`,
      likelyCauses: multi
        ? [
            "Locator quá chung (ví dụ text trùng ở nhiều nút).",
            "UI render thêm element trùng sau lần ghi test.",
          ]
        : [
            "Element nằm trong iframe/popup/tab khác.",
            "Trang chưa điều hướng tới đúng URL hoặc dữ liệu chưa load.",
            "Accessible name/label của element đã đổi (i18n, copy mới).",
          ],
      suggestedFixes: multi
        ? [
            "Dùng Test locator trong Builder để đếm match, rồi thu hẹp (thêm role/name chính xác hoặc chuyển sang testId/label).",
            ...locatorHint(input),
          ]
        : [
            "Dùng Test locator để kiểm tra match count (0 = sai locator; N>1 = thiếu duy nhất).",
            ...timeoutHint(input),
            ...locatorHint(input),
            traceHint(),
          ],
      confidence: "high",
    };
  }
  if (assertMarkers.test(err) || (isAssertStep && /fail/i.test(err))) {
    return {
      category: "assert-mismatch",
      summary: `Assertion thất bại ở step "${input.stepName ?? input.stepType ?? "?"}" — trang render được nhưng giá trị/thấy-không-thấy không khớp kỳ vọng.`,
      likelyCauses: [
        "Dữ liệu kỳ vọng (expected) đã cũ so với UI hiện tại.",
        "Trang chưa load xong khi assertion chạy (thiếu chờ điều kiện).",
        "Locator trỏ đúng element nhưng sai thuộc tính so sánh (text vs value).",
      ],
      suggestedFixes: [
        traceHint(),
        "So sánh expected với text/value thực tế trong trace rồi cập nhật step kỳ vọng.",
        "Chèn waitForElement (visible) ngay trước assertion thay vì chờ cứng.",
        ...locatorHint(input),
      ],
      confidence: assertMarkers.test(err) ? "high" : "medium",
    };
  }
  if (timeoutMarkers.test(e)) {
    return {
      category: "timeout",
      summary: `Step "${input.stepName ?? input.stepType ?? "?"}" hết thời gian chờ — thao tác không hoàn tất trong giới hạn cho phép.`,
      likelyCauses: [
        "Mạng/trang chậm hơn timeout hiện tại.",
        "Element/locator không bao giờ thỏa điều kiện chờ (sai state: visible vs attached).",
        "Điều hướng trước đó chưa xong nên step chạy trên trang cũ.",
      ],
      suggestedFixes: [
        ...timeoutHint(input),
        "Với waitForElement, kiểm tra lại `state` (attached/visible/hidden) có đúng ý đồ không.",
        traceHint(),
        ...locatorHint(input),
      ],
      confidence: input.locator !== undefined || input.timeoutMs !== undefined ? "medium" : "low",
    };
  }
  if (navigationMarkers.test(e)) {
    return {
      category: "navigation",
      summary: `Lỗi điều hướng/tải trang ở step "${input.stepName ?? input.stepType ?? "?"}" — trình duyệt không tới được URL mục tiêu.`,
      likelyCauses: [
        "URL sai, môi trường (environment baseUrl) sai, hoặc server đích sập.",
        "Chứng chỉ TLS/DNS/mạng bị chặn (đặc biệt với target nội bộ).",
        "Redirect chuỗi quá dài hoặc bị chặn bởi SSRF guard.",
      ],
      suggestedFixes: [
        "Mở URL bằng tay / kiểm tra baseUrl của environment đang chạy.",
        "Xem trace để biết dừng ở bước redirect nào.",
        "Nếu target nội bộ, xác nhận ALLOW_PRIVATE_TARGETS chỉ bật ở môi trường local.",
      ],
      confidence: "medium",
    };
  }
  return {
    category: "unknown",
    summary: `Chưa phân loại được lỗi ở step "${input.stepName ?? input.stepType ?? "?"}" — cần xem log đầy đủ và trace để kết luận.`,
    likelyCauses: ["Lỗi hạ tầng (browser crash, worker bị kill) hoặc lỗi chưa có mẫu nhận diện."],
    suggestedFixes: [
      traceHint(),
      "Chạy lại test để loại trừ flaky; nếu lặp lại, copy toàn bộ errorMessage + timeout hiệu lực cho developer.",
    ],
    confidence: "low",
  };
}

/** Prompt template for the LLM path (input must already be redacted). */
export function buildExplainPrompt(input: FailureInput): string {
  const locatorText =
    input.locator === undefined ? "(none)" : JSON.stringify(input.locator).slice(0, 1500);
  return [
    "You are a Playwright test-failure analyst. Classify the failure and reply",
    "with ONE JSON object only: {",
    '  "category": "locator-not-found|timeout|assert-mismatch|navigation|unknown",',
    '  "summary": "<one paragraph, Vietnamese>",',
    '  "likelyCauses": ["..."],',
    '  "suggestedFixes": ["..."],',
    '  "confidence": "low|medium|high"',
    "}.",
    "Rules: P0 executes the primary locator only (never auto-heal); suggest the",
    "in-app locator tester, checking stored alternatives, adjusting the step-level",
    "timeout, adding waitForElement before assertions, and opening the trace/screenshot.",
    `stepType: ${input.stepType ?? "(unknown)"}`,
    `stepName: ${input.stepName ?? "(unknown)"}`,
    `timeoutMs: ${input.timeoutMs ?? "(unknown)"}`,
    `locator: ${locatorText}`,
    `error: ${(input.errorSummary ?? "").slice(0, MAX_PROMPT_ERROR_CHARS)}`,
  ].join("\n");
}

function coerceExplanation(json: string): FailureExplanation | null {
  try {
    const fenced = json.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(fenced) as Partial<FailureExplanation>;
    const cats: FailureCategory[] = ["locator-not-found", "timeout", "assert-mismatch", "navigation", "unknown"];
    if (!parsed || !cats.includes(parsed.category as FailureCategory)) return null;
    if (typeof parsed.summary !== "string") return null;
    if (!Array.isArray(parsed.likelyCauses) || !Array.isArray(parsed.suggestedFixes)) return null;
    const conf = parsed.confidence === "high" || parsed.confidence === "medium" ? parsed.confidence : "low";
    return {
      category: parsed.category as FailureCategory,
      summary: parsed.summary.slice(0, 2000),
      likelyCauses: parsed.likelyCauses.filter((s): s is string => typeof s === "string").slice(0, 8),
      suggestedFixes: parsed.suggestedFixes.filter((s): s is string => typeof s === "string").slice(0, 8),
      confidence: conf,
    };
  } catch {
    return null;
  }
}

/**
 * Explain via LLM when the provider is `llm`, else via rules.
 * LLM JSON-parse failure → honest fallback to rules (`engine: 'rules'`).
 */
export async function explainFailure(
  input: FailureInput,
  provider?: AIProvider,
): Promise<{ engine: "rules" | "llm"; explanation: FailureExplanation }> {
  if (!provider || provider.engine !== "llm") {
    return { engine: "rules", explanation: explainFailureRule(input) };
  }
  try {
    const raw = await provider.complete(buildExplainPrompt(input), {
      systemPrompt: "Reply with a single JSON object. No markdown, no prose.",
      jsonMode: true,
      maxTokens: 800,
    });
    const coerced = coerceExplanation(raw);
    if (!coerced) return { engine: "rules", explanation: explainFailureRule(input) };
    return { engine: "llm", explanation: coerced };
  } catch {
    return { engine: "rules", explanation: explainFailureRule(input) };
  }
}
