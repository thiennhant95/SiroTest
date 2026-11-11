/**
 * explain-failure.ts â€” P2 "AI: failure explanation" (rule path + LLM prompt).
 *
 * Rule engine classifies a failure into one of
 * `locator-not-found | timeout | assert-mismatch | navigation | unknown`
 * and returns likely causes + concrete fixes aligned with user flow C
 * (spec/01-product/user-flows.md: concise error + locator + elapsed timeout +
 * screenshot, Open Trace, Edit locator).
 *
 * With an LLM key, {@link explainFailure} sends a redacted summary through
 * {@link buildExplainPrompt} and coerces the reply into the same schema;
 * any parse failure falls back to the rule engine (engine then reports
 * `'rules'` honestly â€” never a fabricated LLM answer).
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
  /** Test name (metadata only â€” helps ground the summary, never a secret). */
  testName?: string;
  /**
   * One-line run context, e.g. "5/5 prior steps passed (goto, fill, fill, fill, click)
   * before failed step s-assert". Lets the analyst tell "app never navigated"
   * apart from "page was slow".
   */
  priorSummary?: string;
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
    ? ["Step nÃ y Ä‘Ã£ lÆ°u sáºµn locator dá»± phÃ²ng (alternatives) â€” vÃ o Edit locator Ä‘á»ƒ thá»­ tá»«ng candidate. (P0 khÃ´ng tá»± Ä‘á»•i locator khi cháº¡y.)"]
    : ["Step nÃ y chÆ°a cÃ³ locator dá»± phÃ²ng â€” ghi láº¡i báº±ng Record/pick-mode Ä‘á»ƒ lÆ°u thÃªm candidates cho láº§n sá»­a sau."];
}

function timeoutHint(input: FailureInput): string[] {
  if (input.timeoutMs === undefined) return [];
  return [
    `Timeout hiá»‡u lá»±c lÃ  ${input.timeoutMs}ms â€” cÃ¢n nháº¯c tÄƒng timeout á»Ÿ cáº¥p step (Æ°u tiÃªn) thay vÃ¬ chá» cá»©ng waitForTimeout.`,
  ];
}

function traceHint(): string {
  return "Má»Ÿ screenshot/trace cá»§a run Ä‘á»ƒ xem trang á»Ÿ tráº¡ng thÃ¡i nÃ o khi step tháº¥t báº¡i (sai trang? loading chÆ°a xong? popup che?).";
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
        ? `Locator khá»›p NHIá»€U element (strict-mode violation) â€” Playwright tá»« chá»‘i thao tÃ¡c vÃ¬ khÃ´ng xÃ¡c Ä‘á»‹nh duy nháº¥t.`
        : `KhÃ´ng tÃ¬m tháº¥y element cho locator cá»§a step "${input.stepName ?? input.stepType ?? "?"}" trong thá»i gian chá».`,
      likelyCauses: multi
        ? [
            "Locator quÃ¡ chung (vÃ­ dá»¥ text trÃ¹ng á»Ÿ nhiá»u nÃºt).",
            "UI render thÃªm element trÃ¹ng sau láº§n ghi test.",
          ]
        : [
            "Element náº±m trong iframe/popup/tab khÃ¡c.",
            "Trang chÆ°a Ä‘iá»u hÆ°á»›ng tá»›i Ä‘Ãºng URL hoáº·c dá»¯ liá»‡u chÆ°a load.",
            "Accessible name/label cá»§a element Ä‘Ã£ Ä‘á»•i (i18n, copy má»›i).",
          ],
      suggestedFixes: multi
        ? [
            "DÃ¹ng Test locator trong Builder Ä‘á»ƒ Ä‘áº¿m match, rá»“i thu háº¹p (thÃªm role/name chÃ­nh xÃ¡c hoáº·c chuyá»ƒn sang testId/label).",
            ...locatorHint(input),
          ]
        : [
            "DÃ¹ng Test locator Ä‘á»ƒ kiá»ƒm tra match count (0 = sai locator; N>1 = thiáº¿u duy nháº¥t).",
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
      summary: `Assertion tháº¥t báº¡i á»Ÿ step "${input.stepName ?? input.stepType ?? "?"}" â€” trang render Ä‘Æ°á»£c nhÆ°ng giÃ¡ trá»‹/tháº¥y-khÃ´ng-tháº¥y khÃ´ng khá»›p ká»³ vá»ng.`,
      likelyCauses: [
        "Dá»¯ liá»‡u ká»³ vá»ng (expected) Ä‘Ã£ cÅ© so vá»›i UI hiá»‡n táº¡i.",
        "Trang chÆ°a load xong khi assertion cháº¡y (thiáº¿u chá» Ä‘iá»u kiá»‡n).",
        "Locator trá» Ä‘Ãºng element nhÆ°ng sai thuá»™c tÃ­nh so sÃ¡nh (text vs value).",
      ],
      suggestedFixes: [
        traceHint(),
        "So sÃ¡nh expected vá»›i text/value thá»±c táº¿ trong trace rá»“i cáº­p nháº­t step ká»³ vá»ng.",
        "ChÃ¨n waitForElement (visible) ngay trÆ°á»›c assertion thay vÃ¬ chá» cá»©ng.",
        ...locatorHint(input),
      ],
      confidence: assertMarkers.test(err) ? "high" : "medium",
    };
  }
  if (timeoutMarkers.test(e)) {
    return {
      category: "timeout",
      summary: `Step "${input.stepName ?? input.stepType ?? "?"}" háº¿t thá»i gian chá» â€” thao tÃ¡c khÃ´ng hoÃ n táº¥t trong giá»›i háº¡n cho phÃ©p.`,
      likelyCauses: [
        "Máº¡ng/trang cháº­m hÆ¡n timeout hiá»‡n táº¡i.",
        "Element/locator khÃ´ng bao giá» thá»a Ä‘iá»u kiá»‡n chá» (sai state: visible vs attached).",
        "Äiá»u hÆ°á»›ng trÆ°á»›c Ä‘Ã³ chÆ°a xong nÃªn step cháº¡y trÃªn trang cÅ©.",
      ],
      suggestedFixes: [
        ...timeoutHint(input),
        "Vá»›i waitForElement, kiá»ƒm tra láº¡i `state` (attached/visible/hidden) cÃ³ Ä‘Ãºng Ã½ Ä‘á»“ khÃ´ng.",
        traceHint(),
        ...locatorHint(input),
      ],
      confidence: input.locator !== undefined || input.timeoutMs !== undefined ? "medium" : "low",
    };
  }
  if (navigationMarkers.test(e)) {
    return {
      category: "navigation",
      summary: `Lá»—i Ä‘iá»u hÆ°á»›ng/táº£i trang á»Ÿ step "${input.stepName ?? input.stepType ?? "?"}" â€” trÃ¬nh duyá»‡t khÃ´ng tá»›i Ä‘Æ°á»£c URL má»¥c tiÃªu.`,
      likelyCauses: [
        "URL sai, mÃ´i trÆ°á»ng (environment baseUrl) sai, hoáº·c server Ä‘Ã­ch sáº­p.",
        "Chá»©ng chá»‰ TLS/DNS/máº¡ng bá»‹ cháº·n (Ä‘áº·c biá»‡t vá»›i target ná»™i bá»™).",
        "Redirect chuá»—i quÃ¡ dÃ i hoáº·c bá»‹ cháº·n bá»Ÿi SSRF guard.",
      ],
      suggestedFixes: [
        "Má»Ÿ URL báº±ng tay / kiá»ƒm tra baseUrl cá»§a environment Ä‘ang cháº¡y.",
        "Xem trace Ä‘á»ƒ biáº¿t dá»«ng á»Ÿ bÆ°á»›c redirect nÃ o.",
        "Náº¿u target ná»™i bá»™, xÃ¡c nháº­n ALLOW_PRIVATE_TARGETS chá»‰ báº­t á»Ÿ mÃ´i trÆ°á»ng local.",
      ],
      confidence: "medium",
    };
  }
  return {
    category: "unknown",
    summary: `ChÆ°a phÃ¢n loáº¡i Ä‘Æ°á»£c lá»—i á»Ÿ step "${input.stepName ?? input.stepType ?? "?"}" â€” cáº§n xem log Ä‘áº§y Ä‘á»§ vÃ  trace Ä‘á»ƒ káº¿t luáº­n.`,
    likelyCauses: ["Lá»—i háº¡ táº§ng (browser crash, worker bá»‹ kill) hoáº·c lá»—i chÆ°a cÃ³ máº«u nháº­n diá»‡n."],
    suggestedFixes: [
      traceHint(),
      "Cháº¡y láº¡i test Ä‘á»ƒ loáº¡i trá»« flaky; náº¿u láº·p láº¡i, copy toÃ n bá»™ errorMessage + timeout hiá»‡u lá»±c cho developer.",
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
    "Diagnosis rules (apply before the generic rules above):",
    "1. If the failed step is an assert/wait AND priorSummary shows the action",
    "steps before it all passed (fills, clicks, submits), the app most likely",
    "NEVER NAVIGATED: suspect a rejected submit (validation error, duplicate or",
    "reserved data, wrong-page stuck) â€” NOT network slowness. Lead with that",
    "hypothesis and tell the user to open the run screenshot and look for a",
    "validation message. Do not lead with waits/timeouts in this case.",
    "2. For assert steps failing with timeout (no strict-mode violation in the",
    "error), the locator usually resolved fine on the WRONG page â€” deprioritize",
    "locator-alternative advice; prioritize wrong-page/validation checks.",
    "3. Confidence: without page-state evidence (screenshot/trace content) use at",
    "most 'medium'. Use 'high' only when the error text alone proves the cause",
    "(strict-mode match counts, DNS/TLS errors).",
    `testName: ${input.testName ?? "(unknown)"}`,
    `priorSteps: ${input.priorSummary ?? "(unknown)"}`,
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
 * LLM JSON-parse failure â†’ honest fallback to rules (`engine: 'rules'`).
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
