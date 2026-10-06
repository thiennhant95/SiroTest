/**
 * nl-to-steps.ts — P2 "AI: natural-language step/test generation" (rule path).
 *
 * Deterministic EN+VI parser: one clause → zero or more valid P0/P1 steps.
 * Clauses that match nothing are returned in `unparsed[]` EXPLICITLY —
 * this engine never invents steps for text it does not understand.
 *
 * Every emitted step is validated with the canonical test-model schemas
 * before it is returned (unparsable-by-schema steps become `unparsed`
 * instead of leaking invalid shapes to callers).
 *
 * Supported clause patterns (case-insensitive):
 *  - open page:      "mở trang https://…", "open https://…", "go to example.com"
 *  - new tab:        "mở tab mới …", "open new tab …"
 *  - click:          'nhấn nút "Login"', 'click "Submit"' (role button + text alt)
 *  - double-click:   "nhấp đúp …", "double click …"
 *  - fill:           'nhập "john" vào ô "Username"', 'fill "Username" with "john"'
 *  - select:         'chọn "Hà Nội" trong ô "Tỉnh"', 'select "VN" in "Country"'
 *  - check/uncheck:  "tích checkbox X", "check X", "bỏ tích X", "uncheck X"
 *  - press key:      "nhấn phím Enter", "press Enter"
 *  - hover/clear:    "di chuột …", "hover …", "xóa ô …", "clear …"
 *  - waits:          "chờ 2 giây", "wait 500ms", 'chờ "Dashboard" xuất hiện'
 *  - assertions:     "kiểm tra …", "verify …", "expect …" (visible/hidden/text/
 *                    contains/value/url/title/enabled/disabled/checked)
 *  - screenshot:     "chụp ảnh …", "take a screenshot …"
 *  - navigation:     "tải lại trang", "reload", "quay lại", "go back"
 *  - API:            "gọi API GET https://…", "API POST /path"
 */
import { testStepSchema } from "@playwright-studio/test-model";
import type { TestStep } from "@playwright-studio/test-model";

export interface NlToStepsResult {
  steps: TestStep[];
  /** Clauses the rules did not understand — caller must show these, not hide them. */
  unparsed: string[];
}

export type LooseStep = Record<string, unknown>;

let counter = 0;

/** Resettable for deterministic tests. */
export function resetNlStepCounter(): void {
  counter = 0;
}

function nextId(prefix = "nl"): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

function labelTarget(value: string): Record<string, unknown> {
  return {
    primary: { strategy: "label", value },
    alternatives: [{ strategy: "placeholder", value }],
  };
}

function roleTarget(role: string, name: string): Record<string, unknown> {
  return {
    primary: { strategy: "role", role, name },
    alternatives: [{ strategy: "text", value: name }],
  };
}

function textTarget(value: string): Record<string, unknown> {
  return { primary: { strategy: "text", value } };
}

/** Infer a click/assert target from a quoted label + clause hints. */
function inferTarget(quoted: string, clause: string): Record<string, unknown> {
  const c = clause.toLowerCase();
  if (/link|liên kết/.test(c)) return roleTarget("link", quoted);
  if (/checkbox|ô tích/.test(c)) return roleTarget("checkbox", quoted);
  if (/textbox|ô nhập|ô\s|field|input|placeholder/.test(c)) return labelTarget(quoted);
  if (/nút|button/.test(c)) return roleTarget("button", quoted);
  // Default priority per 05-locator: role button (+ accessible name) > text.
  return roleTarget("button", quoted);
}

function quotedAll(clause: string): string[] {
  const out: string[] = [];
  const re = /["“”']([^"“”']+)["“”']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clause)) !== null) out.push(m[1]!.trim());
  return out.filter((s) => s.length > 0);
}

function stripBullet(line: string): string {
  return line
    .replace(/^\s*(?:[-*•>]|\d+[.)]|[a-z][.)])\s+/i, "")
    .trim();
}

/** Split input into clauses: lines, then `;`, then "rồi/then" separators. */
export function splitClauses(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripBullet(rawLine.trim());
    if (!line) continue;
    for (const semi of line.split(/\s*;\s*/)) {
      const parts = semi
        .split(/\s+(?:rồi|then|and then|và sau đó)\s+/i)
        .map((s) => s.trim())
        .filter(Boolean);
      out.push(...parts);
    }
  }
  return out;
}

function normalizeUrl(raw: string): string {
  const cleaned = raw.replace(/[),.;:!?]+$/, "");
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  return `https://${cleaned}`;
}

function isSensitiveLabel(label: string): boolean {
  return /pass|mật khẩu|mat khau|secret|token|pin|otp/i.test(label);
}

function pushIfValid(acc: LooseStep[], unparsed: string[], clause: string, step: LooseStep): void {
  const parsed = testStepSchema.safeParse(step);
  if (parsed.success) {
    acc.push(step);
  } else {
    // Never emit an invalid step — surface the clause as unparsed instead.
    unparsed.push(clause);
  }
}

// ---------------------------------------------------------------- matchers ---

function matchGoto(clause: string): LooseStep | null {
  if (/(tab mới|new tab)/i.test(clause)) return null; // handled by newTab
  const m = /(?:mở|open|go to|navigate to|visit|truy cập|đi tới|vào)\s+(?:trang(?: web)?\s+)?(https?:\/\/[^\s"“”']+|[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-z]{2,}(?:\/[^\s"“”']*)?)/i.exec(clause);
  if (!m) return null;
  const url = normalizeUrl(m[1]!);
  return { id: nextId(), type: "goto", name: `Mở ${url}`, enabled: true, url };
}

function matchNewTab(clause: string): LooseStep | null {
  if (!/(tab mới|new tab)/i.test(clause)) return null;
  const urlM = /(https?:\/\/[^\s"“”']+)/i.exec(clause);
  const step: LooseStep = { id: nextId(), type: "newTab", enabled: true };
  step.name = urlM ? `Mở tab mới ${urlM[1]}` : "Mở tab mới";
  if (urlM) step.url = urlM[1];
  return step;
}

function matchApi(clause: string): LooseStep | null {
  const m = /\bapi\b\s+(GET|POST|PUT|PATCH|DELETE)\s+(https?:\/\/\S+|\/\S+)/i.exec(clause);
  if (!m) return null;
  const method = m[1]!.toUpperCase();
  const url = m[2]!.replace(/[),.;]+$/, "");
  return {
    id: nextId(), type: "apiRequest", name: `Gọi API ${method} ${url}`,
    enabled: true, method, url, expectedStatus: 200,
  };
}

function matchFill(clause: string): LooseStep | null {
  if (!/(điền|nhập|fill|enter|type|gõ)\b/i.test(clause)) return null;
  // Password-like "********" values stay literal — never synthesized.
  const q = quotedAll(clause);
  let label: string | null = null;
  let value: string | null = null;
  let m: RegExpExecArray | null;
  if ((m = /fill\s+["“”']([^"“”']+)["“”']\s+with\s+["“”']([^"“”']+)["“”']/i.exec(clause)) !== null) {
    label = m[1]!.trim(); value = m[2]!;
  } else if (
    (m = /["“”']([^"“”']+)["“”']\s+(?:vào|into|in|trong)\s+(?:ô\s+|field\s+|trường\s+|textbox\s+)?["“”']([^"“”']+)["“”']/i.exec(clause)) !== null
  ) {
    value = m[1]!; label = m[2]!.trim();
  } else if (
    (m = /(?:ô|field|textbox|trường)\s+["“”']([^"“”']+)["“”']\s*(?:với|là|with|is|=|:)\s*["“”']([^"“”']*)["“”']/i.exec(clause)) !== null
  ) {
    label = m[1]!.trim(); value = m[2]!;
  } else if (
    (m = /(?:nhập|điền|nhap|dien)\s+["“”']([^"“”']+)["“”']\s+(?:là|la|=|:)\s*["“”']?([^"“”']+)["“”']?/i.exec(clause)) !== null
  ) {
    // Natural VI: nhập "Email" là "a@x.io" (label first, value second).
    label = m[1]!.trim(); value = m[2]!.trim();
  } else if (q.length >= 2) {
    if (/(điền|nhập|gõ)\b/i.test(clause)) { value = q[0]!; label = q[1]!; }
    else { label = q[0]!; value = q[1]!; }
  } else if (q.length === 1) {
    // `key=value` form: nhập Email=test@example.com / fill Email=test@…
    const kv = /(\S+?)\s*=\s*(\S+)/.exec(clause);
    if (!kv) return null;
    label = q[0]!;
    value = kv[2]!;
  } else if (
    (m = /(?:nhập|điền|nhap|dien|enter|type|gõ)\s+(.+?)\s+(?:là|la|=|:)\s*(.+)/i.exec(clause)) !== null
  ) {
    // Unquoted VI: nhập mật khẩu là 123456 (label up to `là`, value after).
    label = m[1]!.trim(); value = m[2]!.trim().replace(/^["“”']|["“”']$/g, '');
    if (!label || !value) return null;
  } else if (
    (m = /(?:nhập|điền|nhap|dien|enter|type|gõ)\s+(.+?)\s+([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|https?:\/\/\S+|\d[\d\s.]*\d|\d+)/i.exec(clause)) !== null
  ) {
    // Unquoted `verb label value`: điền email test@x.io — value must look
    // like an email/URL/number, otherwise the boundary is unknowable.
    label = m[1]!.trim(); value = m[2]!.trim();
    if (!label || !value) return null;
  } else {
    return null;
  }
  if (!label || value === null) return null;
  const sensitive = isSensitiveLabel(label);
  const step: LooseStep = {
    id: nextId(), type: "fill", name: `Nhập ${label}${sensitive ? " (đã che)" : ""}`,
    enabled: true, target: labelTarget(label), value,
  };
  if (sensitive) step.sensitive = true;
  return step;
}

function matchSelect(clause: string): LooseStep | null {
  if (!/(chọn|select|choose)\b/i.test(clause)) return null;
  const q = quotedAll(clause);
  // Two-quote form only — a single "chọn X" is a check (checkbox), not a select.
  if (q.length < 2) return null;
  const m = /["“”'][^"“”']+["“”']\s+(?:trong|in|tại)\s+(?:ô\s+)?["“”']([^"“”']+)["“”']/i.exec(clause);
  const label = m ? m[1]!.trim() : q[1]!;
  const value = q[0]!;
  return {
    id: nextId(), type: "select", name: `Chọn ${label} = ${value}`,
    enabled: true, target: labelTarget(label), value,
  };
}

function matchCheck(clause: string): LooseStep | null {
  const uncheckFirst = /(bỏ (tích|chọn|check|đánh dấu)|uncheck|bỏ chọn)/i.test(clause);
  if (uncheckFirst) {
    const q = quotedAll(clause);
    if (q.length === 0) return null;
    return {
      id: nextId(), type: "uncheck", name: `Bỏ chọn "${q[0]}"`,
      enabled: true, target: roleTarget("checkbox", q[0]!),
    };
  }
  if (!/(tích\b|đánh dấu|\bcheck\b)/i.test(clause)) {
    // Vietnamese single-quote "chọn X" (no value pair) = tick a checkbox.
    if (!/chọn/i.test(clause)) return null;
    if (quotedAll(clause).length !== 1) return null;
  }
  const q = quotedAll(clause);
  if (q.length === 0) return null;
  return {
    id: nextId(), type: "check", name: `Tích chọn "${q[0]}"`,
    enabled: true, target: roleTarget("checkbox", q[0]!),
  };
}

function matchPress(clause: string): LooseStep | null {
  const m = /(?:nhấn\s+phím|press\s+(?:key\s+)?)\s*["“”']?([A-Za-z]+)["“”']?/i.exec(clause)
    ?? /(?:nhấn|press)\s+(Enter|Escape|Esc|Tab|Backspace|Delete|Arrow\w+)\b/i.exec(clause);
  if (!m) return null;
  const key = m[1]!.length > 1 && /^[a-z]+$/i.test(m[1]!) && !/^(Enter|Escape|Esc|Tab|Backspace|Delete|Arrow\w+)$/i.test(m[1]!)
    ? m[1]!
    : normalizeKey(m[1]!);
  return { id: nextId(), type: "press", name: `Nhấn phím ${key}`, enabled: true, key };
}

function normalizeKey(raw: string): string {
  const k = raw.toLowerCase();
  if (k === "esc") return "Escape";
  return raw.length === 1 ? raw : raw[0]!.toUpperCase() + raw.slice(1);
}

function matchClick(clause: string): LooseStep | null {
  const dbl = /(nhấp đúp|nhấn đúp|double[\s-]?click)/i.test(clause);
  if (!dbl && !/(nhấn|nhấp|click|bấm)\b/i.test(clause)) return null;
  if (!dbl && /(phím|key)\s/i.test(clause)) return null; // press-key owns this
  const q = quotedAll(clause);
  const bareBtn = /(nút|button)\s+([A-Za-zÀ-ỹ0-9_.-]+)/i.exec(clause);
  const label = q[0] ?? (bareBtn ? bareBtn[2]! : null);
  if (!label) return null;
  const type = dbl ? "doubleClick" : "click";
  return {
    id: nextId(), type, name: `${dbl ? "Nhấp đúp" : "Nhấn"} "${label}"`,
    enabled: true, target: inferTarget(label, clause),
  };
}

function matchHoverClear(clause: string): LooseStep | null {
  const q = quotedAll(clause);
  if (/(hover|di chuột|rë chuột|rê chuột)/i.test(clause)) {
    if (q.length === 0) return null;
    return {
      id: nextId(), type: "hover", name: `Di chuột qua "${q[0]}"`,
      enabled: true, target: inferTarget(q[0]!, clause),
    };
  }
  if (/(xóa|xoa|clear)\b/i.test(clause) && q.length > 0) {
    return {
      id: nextId(), type: "clear", name: `Xóa ô "${q[0]}"`,
      enabled: true, target: labelTarget(q[0]!),
    };
  }
  return null;
}

function matchWait(clause: string): LooseStep | null {
  const fixed = /(?:chờ|wait|đợi)\s+(\d+)\s*(ms|mili|mili giây|giây|second|seconds|s\b)?/i.exec(clause);
  if (fixed && !/["“”']/.test(clause)) {
    const n = Number(fixed[1]);
    const unit = (fixed[2] ?? "ms").toLowerCase();
    const milliseconds = /giây|second/.test(unit) || unit.trim() === "s" ? n * 1000 : n;
    return {
      id: nextId(), type: "waitForTimeout", name: `Chờ ${milliseconds}ms`,
      enabled: true, milliseconds,
    };
  }
  if (!/(chờ|wait|đợi)/i.test(clause)) return null;
  const urlQ = /(url|địa chỉ).*?["“”']([^"“”']+)["“”']/i.exec(clause);
  if (urlQ) {
    return {
      id: nextId(), type: "waitForURL", name: `Chờ URL ${urlQ[2]}`,
      enabled: true, url: urlQ[2],
    };
  }
  const q = quotedAll(clause);
  if (q.length === 0) return null;
  const state = /(biến mất|không còn|disappear|hidden)/i.test(clause) ? "hidden" : "visible";
  return {
    id: nextId(), type: "waitForElement",
    name: `Chờ "${q[0]}" ${state === "visible" ? "xuất hiện" : "biến mất"}`,
    enabled: true, target: inferTarget(q[0]!, clause), state,
  };
}

function matchAssert(clause: string): LooseStep | null {
  const asserts = /(kiểm tra|verify|expect|assert|đảm bảo|xác minh)/i.test(clause);
  const q = quotedAll(clause);
  // URL / title (work with or without an assert verb in VI bare form).
  const urlM = /(url|địa chỉ).*?["“”']([^"“”']+)["“”']/i.exec(clause);
  if (urlM && (asserts || /(là|is|=|chứa|contains)/i.test(clause))) {
    const isPattern = /(chứa|contains|\*)/.test(clause);
    const step: LooseStep = { id: nextId(), type: "assertURL", enabled: true };
    if (isPattern) { step.pattern = urlM[2]; step.name = `Kiểm tra URL chứa ${urlM[2]}`; }
    else { step.expected = urlM[2]; step.name = `Kiểm tra URL là ${urlM[2]}`; }
    return step;
  }
  const titleM = /(title|tiêu đề).*?["“”']([^"“”']+)["“”']/i.exec(clause);
  if (titleM && (asserts || /(là|is|=)/i.test(clause))) {
    return {
      id: nextId(), type: "assertTitle", name: `Kiểm tra tiêu đề "${titleM[2]}"`,
      enabled: true, expected: titleM[2]!,
    };
  }
  if (!asserts) {
    // Bare VI forms without an explicit verb.
    if (/(không thấy|không hiển thị|ẩn\b|hidden)/i.test(clause) && q.length > 0) {
      return {
        id: nextId(), type: "assertHidden", name: `Kiểm tra "${q[0]}" đã ẩn`,
        enabled: true, target: inferTarget(q[0]!, clause),
      };
    }
    if (/(thấy|hiển thị|xuất hiện|visible)/i.test(clause) && q.length > 0) {
      return {
        id: nextId(), type: "assertVisible", name: `Kiểm tra "${q[0]}" hiển thị`,
        enabled: true, target: inferTarget(q[0]!, clause),
      };
    }
    return null;
  }
  if (/(không thấy|không hiển thị|ẩn\b|hidden|biến mất)/i.test(clause) && q.length > 0) {
    return {
      id: nextId(), type: "assertHidden", name: `Kiểm tra "${q[0]}" đã ẩn`,
      enabled: true, target: inferTarget(q[0]!, clause),
    };
  }
  const twoQ = q.length >= 2;
  if (/(chứa|contains)/i.test(clause) && twoQ) {
    return {
      id: nextId(), type: "assertContainsText", name: `Kiểm tra "${q[0]}" chứa "${q[1]}"`,
      enabled: true, target: textTarget(q[0]!), expected: q[1]!,
    };
  }
  if (/(giá trị|value)\b/i.test(clause) && twoQ) {
    return {
      id: nextId(), type: "assertValue", name: `Kiểm tra giá trị "${q[0]}"`,
      enabled: true, target: labelTarget(q[0]!), expected: q[1]!,
    };
  }
  if (/(text|văn bản|nội dung)\b/i.test(clause) && twoQ) {
    return {
      id: nextId(), type: "assertText", name: `Kiểm tra text "${q[0]}"`,
      enabled: true, target: textTarget(q[0]!), expected: q[1]!,
    };
  }
  if (/(checked|đã tích|được tích)/i.test(clause) && q.length > 0) {
    return {
      id: nextId(), type: "assertChecked", name: `Kiểm tra "${q[0]}" đã được tích`,
      enabled: true, target: roleTarget("checkbox", q[0]!),
    };
  }
  if (/(disabled|bị (vô hiệu|disable)|mờ\b)/i.test(clause) && q.length > 0) {
    return {
      id: nextId(), type: "assertDisabled", name: `Kiểm tra "${q[0]}" bị vô hiệu`,
      enabled: true, target: inferTarget(q[0]!, clause),
    };
  }
  if (/(enabled|khả dụng|có thể nhấn)/i.test(clause) && q.length > 0) {
    return {
      id: nextId(), type: "assertEnabled", name: `Kiểm tra "${q[0]}" khả dụng`,
      enabled: true, target: inferTarget(q[0]!, clause),
    };
  }
  if (q.length > 0) {
    // Generic "kiểm tra X" (flow B assertion language) → visible by default.
    return {
      id: nextId(), type: "assertVisible", name: `Kiểm tra "${q[0]}" hiển thị`,
      enabled: true, target: inferTarget(q[0]!, clause),
    };
  }
  return null;
}

function matchScreenshot(clause: string): LooseStep | null {
  if (!/(chụp|screenshot|snapshot|ảnh màn hình)/i.test(clause)) return null;
  const q = quotedAll(clause);
  const step: LooseStep = { id: nextId(), type: "screenshot", enabled: true };
  step.name = q[0] ? `Chụp ảnh "${q[0]}"` : "Chụp ảnh màn hình";
  if (q[0]) step.name = q[0];
  if (/(full|toàn trang)/i.test(clause)) step.fullPage = true;
  return step;
}

function matchNav(clause: string): LooseStep | null {
  if (/(tải lại|reload|refresh|f5)\b/i.test(clause)) {
    return { id: nextId(), type: "reload", name: "Tải lại trang", enabled: true };
  }
  if (/(quay lại|go back|\bback\b)/i.test(clause) && !/quay lại trang chủ/i.test(clause)) {
    return { id: nextId(), type: "goBack", name: "Quay lại", enabled: true };
  }
  if (/(tiến tới|go forward|\bforward\b)/i.test(clause)) {
    return { id: nextId(), type: "goForward", name: "Tiến tới", enabled: true };
  }
  return null;
}

// ------------------------------------------------------------------ entry ---

/** Ordered matcher pipeline — specific verbs win over generic ones. */
const MATCHERS: Array<(clause: string) => LooseStep | null> = [
  matchNewTab,
  matchApi,
  matchGoto,
  matchFill,
  matchSelect,
  matchCheck,
  matchPress,
  matchWait,
  matchAssert,
  matchClick,
  matchHoverClear,
  matchScreenshot,
  matchNav,
];

/**
 * Run one clause through the matcher pipeline. Returns the first match
 * (with a minted `nl_<n>` id) or null when nothing understands the clause.
 * Pure except for the deterministic id counter — see resetNlStepCounter.
 */
export function parseNlClause(clause: string): LooseStep | null {
  for (const match of MATCHERS) {
    const emitted = match(clause);
    if (emitted) return emitted;
  }
  return null;
}

/**
 * Parse free text into P0/P1 steps. Pure + deterministic.
 * Unknown clauses → `unparsed` (never fabricated into steps).
 */
export function nlToSteps(text: string): NlToStepsResult {
  const steps: LooseStep[] = [];
  const unparsed: string[] = [];
  for (const clause of splitClauses(text)) {
    const emitted = parseNlClause(clause);
    if (!emitted) {
      unparsed.push(clause);
      continue;
    }
    pushIfValid(steps, unparsed, clause, emitted);
  }
  return { steps: steps as unknown as TestStep[], unparsed };
}

/**
 * Validate LLM-produced step candidates with the canonical schemas.
 * Invalid entries are counted (caller surfaces them as unparsed) —
 * never thrown, never silently emitted.
 */
export function validateGeneratedSteps(candidates: unknown[]): {
  valid: TestStep[];
  invalidCount: number;
} {
  const valid: TestStep[] = [];
  let invalidCount = 0;
  for (const c of candidates) {
    const parsed = testStepSchema.safeParse(c);
    if (parsed.success) valid.push(parsed.data as TestStep);
    else invalidCount += 1;
  }
  return { valid, invalidCount };
}

/** System prompt used when an LLM key IS configured (server route). */
export function nlToStepsSystemPrompt(): string {
  return [
    "You convert a QA tester's natural-language instruction (English or Vietnamese)",
    "into Playwright Studio test steps. Respond with a single JSON object:",
    '{"steps": [<TestStep>...], "unparsed": ["..."]}.',
    "Step types (P0): goto{url}, click{target}, doubleClick{target}, fill{target,value},",
    "clear{target}, press{key,target?}, check{target}, uncheck{target}, select{target,value},",
    "hover{target}, waitForElement{target,state}, waitForTimeout{milliseconds},",
    "waitForURL{url|pattern}, assertVisible/assertHidden{target}, assertText/assertContainsText/assertValue{target,expected},",
    "assertURL{expected|pattern}, assertTitle{expected}, assertEnabled/assertDisabled/assertChecked{target},",
    "screenshot{name?,fullPage?}. P1: newTab{url?}, apiRequest{method,url,expectedStatus?}.",
    'Every step needs {"id":"nl_<n>","type":...,"enabled":true}.',
    'LocatorSpec: {"primary":{"strategy":"role","role":"button","name":"X"}} or',
    '{"primary":{"strategy":"label","value":"X"}} or {"primary":{"strategy":"text","value":"X"}}.',
    "Put anything you cannot map into unparsed — never invent steps.",
  ].join(" ");
}
