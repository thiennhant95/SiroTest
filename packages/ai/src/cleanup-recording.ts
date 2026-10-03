/**
 * cleanup-recording.ts — P2 "AI: clean raw recording into business steps".
 *
 * Deterministic batch post-processor for raw recorder output. Reuses the
 * ideas from `packages/recorder/src/normalize.ts` (typing debounce merge,
 * click-into-input removal, redirect collapse) and adds:
 *  - business-readable `name` assignment (only when missing/blank),
 *  - assertion suggestions (fill → assertValue, click → assertVisible)
 *    recorded as reviewable {@link CleanupChange} entries — NEVER auto-inserted,
 *  - a full `changes[]` log so the user can review every transformation.
 *
 * Pure function, no writes: the caller decides whether to persist the
 * result (the server route returns preview only, never PATCHes the test).
 */
import { testStepSchema } from "@playwright-studio/test-model";
import type { TestStep } from "@playwright-studio/test-model";

export type CleanupChangeKind =
  | "merge-fill"
  | "drop-click-before-fill"
  | "merge-goto"
  | "rename"
  | "suggest-assertion"
  | "kept-unrecognized";

export interface CleanupChange {
  kind: CleanupChangeKind;
  /** Human-readable (Vietnamese) description for review UI. */
  description: string;
  stepIds: string[];
  /** Present only for `suggest-assertion` — a step the user may insert. */
  suggestedStep?: Record<string, unknown>;
}

export interface CleanupResult {
  steps: TestStep[];
  changes: CleanupChange[];
}

type Loose = Record<string, unknown>;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function stepId(s: Loose): string {
  return typeof s.id === "string" ? s.id : "?";
}

/** Identity of the element a step acts on (for merge/drop decisions). */
function targetKey(s: Loose): string | null {
  const t = s.target as Loose | undefined;
  if (!t || typeof t !== "object") return null;
  return JSON.stringify((t.primary ?? t) as unknown);
}

function primaryLabel(s: Loose): string {
  const t = s.target as Loose | undefined;
  const p = (t?.primary ?? {}) as Loose;
  if (typeof p.name === "string" && p.name) return p.name;
  if (typeof p.value === "string" && p.value) return p.value;
  if (typeof p.role === "string" && p.role) return p.role;
  return "element";
}

function mask(value: unknown, sensitive: boolean): string {
  if (!sensitive) return String(value ?? "");
  return "***MASKED***";
}

/** Business-readable name per step type (flow A: "clean names"). */
export function businessName(s: Loose): string {
  const type = s.type as string;
  switch (type) {
    case "goto": return `Mở ${String(s.url ?? "")}`;
    case "reload": return "Tải lại trang";
    case "goBack": return "Quay lại";
    case "goForward": return "Tiến tới";
    case "click": return `Nhấn "${primaryLabel(s)}"`;
    case "doubleClick": return `Nhấp đúp "${primaryLabel(s)}"`;
    case "fill": return `Nhập ${primaryLabel(s)}${s.sensitive ? " (đã che)" : ""}`;
    case "clear": return `Xóa ô "${primaryLabel(s)}"`;
    case "press": return `Nhấn phím ${String(s.key ?? "")}`;
    case "check": return `Tích chọn "${primaryLabel(s)}"`;
    case "uncheck": return `Bỏ chọn "${primaryLabel(s)}"`;
    case "select": return `Chọn ${primaryLabel(s)} = ${mask(s.value, false)}`;
    case "hover": return `Di chuột qua "${primaryLabel(s)}"`;
    case "waitForElement": return `Chờ "${primaryLabel(s)}" xuất hiện`;
    case "waitForTimeout": return `Chờ ${String(s.milliseconds ?? 0)}ms`;
    case "waitForURL": return `Chờ URL ${String(s.url ?? s.pattern ?? "")}`;
    case "assertVisible": return `Kiểm tra "${primaryLabel(s)}" hiển thị`;
    case "assertHidden": return `Kiểm tra "${primaryLabel(s)}" đã ẩn`;
    case "assertText": return `Kiểm tra text "${primaryLabel(s)}"`;
    case "assertContainsText": return `Kiểm tra "${primaryLabel(s)}" chứa text`;
    case "assertValue": return `Kiểm tra giá trị "${primaryLabel(s)}"`;
    case "assertURL": return `Kiểm tra URL`;
    case "assertTitle": return `Kiểm tra tiêu đề`;
    case "assertEnabled": return `Kiểm tra "${primaryLabel(s)}" khả dụng`;
    case "assertDisabled": return `Kiểm tra "${primaryLabel(s)}" bị vô hiệu`;
    case "assertChecked": return `Kiểm tra "${primaryLabel(s)}" đã được tích`;
    case "screenshot": return typeof s.name === "string" && s.name ? s.name : "Chụp ảnh màn hình";
    case "newTab": return typeof s.url === "string" && s.url ? `Mở tab mới ${s.url}` : "Mở tab mới";
    case "closeTab": return "Đóng tab hiện tại";
    case "handleDialog": return `${s.action === "dismiss" ? "Từ chối" : "Chấp nhận"} hộp thoại`;
    case "apiRequest": return `Gọi API ${String(s.method ?? "")} ${String(s.url ?? "")}`;
    default: return `${type} (giữ nguyên — xem lại thủ công)`;
  }
}

let suggestCounter = 0;

/** Resettable for deterministic tests. */
export function resetCleanupCounter(): void {
  suggestCounter = 0;
}

function suggestId(base: string): string {
  suggestCounter += 1;
  return `${base}_suggest_${suggestCounter}`;
}

/**
 * Clean raw steps. Input accepts recorder-shaped or TestDefinition-shaped
 * step objects; output steps are schema-validated (invalid survivors are
 * kept but flagged `kept-unrecognized` for manual review).
 */
export function cleanupRecording(input: Loose[]): CleanupResult {
  const changes: CleanupChange[] = [];
  const working: Loose[] = input.map(clone);

  // 1) Merge adjacent fills on the same target (typing debounce, batch form).
  const merged: Loose[] = [];
  for (const s of working) {
    const prev = merged[merged.length - 1];
    if (
      prev && prev.type === "fill" && s.type === "fill" &&
      targetKey(prev) !== null && targetKey(prev) === targetKey(s)
    ) {
      const before = (prev.value as string) ?? "";
      prev.value = (s.value as string) ?? "";
      prev.sensitive = Boolean(prev.sensitive || s.sensitive);
      changes.push({
        kind: "merge-fill",
        description: `Gộp ${before === "" ? "fill rỗng" : `fill "${mask(before, Boolean(prev.sensitive))}"`} + fill "${mask(prev.value, Boolean(prev.sensitive))}" trên "${primaryLabel(prev)}" thành một step (giữ giá trị cuối).`,
        stepIds: [stepId(prev), stepId(s)],
      });
      continue;
    }
    merged.push(s);
  }

  // 2) Drop click-into-input immediately before a fill on the same target.
  const deduped: Loose[] = [];
  for (let i = 0; i < merged.length; i++) {
    const cur = merged[i]!;
    const nxt = merged[i + 1];
    if (
      cur.type === "click" && nxt && nxt.type === "fill" &&
      targetKey(cur) !== null && targetKey(cur) === targetKey(nxt)
    ) {
      changes.push({
        kind: "drop-click-before-fill",
        description: `Xóa click focus vào "${primaryLabel(cur)}" đứng ngay trước fill (click không mang ý nghĩa nghiệp vụ).`,
        stepIds: [stepId(cur), stepId(nxt)],
      });
      continue;
    }
    deduped.push(cur);
  }

  // 3) Collapse consecutive gotos (redirect chains) — keep the last URL.
  const collapsed: Loose[] = [];
  for (const s of deduped) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.type === "goto" && s.type === "goto") {
      const dropped = prev.url as string;
      prev.url = s.url;
      changes.push({
        kind: "merge-goto",
        description: `Gộp redirect: bỏ goto "${dropped}", giữ goto cuối "${s.url}".`,
        stepIds: [stepId(prev), stepId(s)],
      });
      continue;
    }
    collapsed.push(s);
  }

  // 4) Business-readable names where missing/blank.
  for (const s of collapsed) {
    if (typeof s.name !== "string" || s.name.trim() === "") {
      const name = businessName(s);
      // Screenshot keeps its own optional name; businessName already handles it.
      if (s.type === "screenshot" && name === "Chụp ảnh màn hình" && s.name !== undefined) continue;
      s.name = name;
      changes.push({
        kind: "rename",
        description: `Đặt tên step ${stepId(s)} (${String(s.type)}): "${name}".`,
        stepIds: [stepId(s)],
      });
    }
  }

  // 5) Assertion suggestions (preview only — never inserted automatically).
  for (const s of collapsed) {
    if (s.type === "fill" && s.target) {
      const sensitive = Boolean(s.sensitive);
      const suggestedStep: Loose = {
        id: suggestId(stepId(s)),
        type: "assertValue",
        name: `Kiểm tra giá trị "${primaryLabel(s)}"`,
        enabled: true,
        target: clone(s.target),
        expected: sensitive ? "***MASKED***" : String(s.value ?? ""),
      };
      changes.push({
        kind: "suggest-assertion",
        description: sensitive
          ? `Gợi ý: chèn assertValue sau fill "${primaryLabel(s)}" (giá trị đã che — bạn điền kỳ vọng trước khi lưu).`
          : `Gợi ý: chèn assertValue sau fill "${primaryLabel(s)}" để khóa giá trị vừa nhập.`,
        stepIds: [stepId(s)],
        suggestedStep,
      });
    } else if (s.type === "click" && s.target) {
      // Skip focus-clicks already removed; suggest visibility of the same target.
      const suggestedStep: Loose = {
        id: suggestId(stepId(s)),
        type: "assertVisible",
        name: `Kiểm tra "${primaryLabel(s)}" hiển thị`,
        enabled: true,
        target: clone(s.target),
      };
      changes.push({
        kind: "suggest-assertion",
        description: `Gợi ý: chèn assertVisible cho "${primaryLabel(s)}" sau click (xác nhận điều hướng/UI phản hồi — chỉnh target nếu cần).`,
        stepIds: [stepId(s)],
        suggestedStep,
      });
    }
  }

  // 6) Validate survivors; flag (but keep) anything off-schema.
  const steps: TestStep[] = [];
  for (const s of collapsed) {
    const parsed = testStepSchema.safeParse(s);
    if (parsed.success) {
      steps.push(parsed.data as TestStep);
    } else {
      steps.push(s as unknown as TestStep);
      changes.push({
        kind: "kept-unrecognized",
        description: `Giữ nguyên step ${stepId(s)} (type "${String(s.type)}") — không khớp schema P0/P1, cần xem lại thủ công.`,
        stepIds: [stepId(s)],
      });
    }
  }
  // Validate suggestion payloads too; drop invalid ones (with a note).
  for (const c of changes) {
    if (c.kind === "suggest-assertion" && c.suggestedStep) {
      if (!testStepSchema.safeParse(c.suggestedStep).success) delete c.suggestedStep;
    }
  }
  return { steps, changes };
}
