/**
 * Step catalog metadata for the visual builder.
 * Sources: 03-test-model/step-catalog.md + packages/test-model/src/types.ts.
 * Business-readable labels/keywords so manual testers never see page.locator().
 */

export type StepGroup =
  | "Navigation"
  | "Interaction"
  | "Wait"
  | "Assertion"
  | "Utility";

export interface LocatorCandidate {
  strategy: "role" | "label" | "placeholder" | "testId" | "text" | "css" | "xpath";
  role?: string;
  name?: string;
  value?: string;
  exact?: boolean;
  [k: string]: unknown;
}

export interface LocatorSpec {
  primary: LocatorCandidate;
  alternatives?: LocatorCandidate[];
}

export interface BuilderStep {
  id: string;
  type: string;
  name?: string;
  enabled: boolean;
  timeoutMs?: number;
  continueOnFailure?: boolean;
  [k: string]: unknown;
}

export interface BuilderDefinition {
  schemaVersion: "1.0";
  id: string;
  projectId: string;
  name: string;
  description?: string;
  browser: "chromium" | "firefox" | "webkit";
  baseUrl?: string;
  variables?: Record<string, string>;
  steps: BuilderStep[];
}

export interface StepMeta {
  type: string;
  /** Business-readable label, e.g. "Fill text field". */
  label: string;
  icon: string;
  group: StepGroup;
  description: string;
  /** Human search terms (EN + VI). */
  keywords: string[];
  hasTarget: boolean;
  warnFixedWait?: boolean;
  make: () => Record<string, unknown>;
}

export function uid(prefix = "step"): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
    }
  } catch {
    /* fallback below */
  }
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function target(
  strategy: LocatorCandidate["strategy"] = "role",
  extra: Record<string, unknown> = {},
): LocatorSpec {
  const base: LocatorCandidate =
    strategy === "role"
      ? { strategy, role: "button", name: "", ...extra }
      : { strategy, value: "", ...extra };
  return { primary: base };
}

export const STEP_GROUPS: StepGroup[] = [
  "Navigation",
  "Interaction",
  "Wait",
  "Assertion",
  "Utility",
];

export const STEP_CATALOG: StepMeta[] = [
  // -- Navigation --
  { type: "goto", label: "Go to page", icon: "→", group: "Navigation", description: "Mở một URL", keywords: ["goto", "navigate", "url", "trang", "mở", "điều hướng", "open", "page"], hasTarget: false, make: () => ({ url: "/login" }) },
  { type: "reload", label: "Reload page", icon: "↻", group: "Navigation", description: "Tải lại trang", keywords: ["reload", "refresh", "tải lại", "refresh"], hasTarget: false, make: () => ({}) },
  { type: "goBack", label: "Go back", icon: "←", group: "Navigation", description: "Quay lại trang trước", keywords: ["back", "quay lại", "history"], hasTarget: false, make: () => ({}) },
  { type: "goForward", label: "Go forward", icon: "→", group: "Navigation", description: "Tiến tới trang sau", keywords: ["forward", "tiến", "history"], hasTarget: false, make: () => ({}) },
  // -- Interaction --
  { type: "click", label: "Click", icon: "👆", group: "Interaction", description: "Nhấn vào một phần tử", keywords: ["click", "nhấn", "nhấp", "button", "nút", "press", "tap"], hasTarget: true, make: () => ({ target: target() }) },
  { type: "doubleClick", label: "Double click", icon: "👆👆", group: "Interaction", description: "Nhấn đúp", keywords: ["double", "nhấp đúp", "doubleclick"], hasTarget: true, make: () => ({ target: target() }) },
  { type: "fill", label: "Fill text field", icon: "✎", group: "Interaction", description: "Điền text vào ô nhập", keywords: ["fill", "điền", "nhập", "email", "text", "textbox", "field", "input", "type"], hasTarget: true, make: () => ({ target: target("label"), value: "" }) },
  { type: "clear", label: "Clear field", icon: "⌫", group: "Interaction", description: "Xóa nội dung ô nhập", keywords: ["clear", "xóa", "empty"], hasTarget: true, make: () => ({ target: target("label") }) },
  { type: "press", label: "Press key", icon: "⌨", group: "Interaction", description: "Nhấn phím (Enter, Tab…)", keywords: ["press", "key", "phím", "enter", "tab", "keyboard"], hasTarget: false, make: () => ({ key: "Enter" }) },
  { type: "check", label: "Check checkbox", icon: "☑", group: "Interaction", description: "Tick checkbox", keywords: ["check", "tick", "checkbox", "chọn"], hasTarget: true, make: () => ({ target: target() }) },
  { type: "uncheck", label: "Uncheck checkbox", icon: "☐", group: "Interaction", description: "Bỏ tick checkbox", keywords: ["uncheck", "untick", "bỏ chọn", "checkbox"], hasTarget: true, make: () => ({ target: target() }) },
  { type: "select", label: "Select option", icon: "▾", group: "Interaction", description: "Chọn option trong dropdown", keywords: ["select", "dropdown", "option", "chọn", "combobox"], hasTarget: true, make: () => ({ target: target("label"), value: "" }) },
  { type: "hover", label: "Hover", icon: "◈", group: "Interaction", description: "Di chuột lên phần tử", keywords: ["hover", "di chuột", "mouse"], hasTarget: true, make: () => ({ target: target() }) },
  // -- Wait --
  { type: "waitForElement", label: "Wait for element", icon: "⏳", group: "Wait", description: "Chờ phần tử theo trạng thái", keywords: ["wait", "chờ", "element", "visible", "state"], hasTarget: true, make: () => ({ target: target(), state: "visible" }) },
  { type: "waitForTimeout", label: "Fixed wait", icon: "⏱", group: "Wait", description: "Chờ cứng N mili-giây", keywords: ["wait", "timeout", "sleep", "chờ", "giây", "fixed", "delay"], hasTarget: false, warnFixedWait: true, make: () => ({ milliseconds: 1000 }) },
  { type: "waitForURL", label: "Wait for URL", icon: "🔗", group: "Wait", description: "Chờ URL đổi sang mẫu", keywords: ["wait", "url", "chờ", "redirect", "pattern"], hasTarget: false, make: () => ({ url: "" }) },
  // -- Assertions --
  { type: "assertVisible", label: "Assert visible", icon: "✓", group: "Assertion", description: "Kiểm tra phần tử hiển thị", keywords: ["assert", "visible", "hiển thị", "check", "verify", "thấy"], hasTarget: true, make: () => ({ target: target() }) },
  { type: "assertHidden", label: "Assert hidden", icon: "✕", group: "Assertion", description: "Kiểm tra phần tử bị ẩn", keywords: ["assert", "hidden", "ẩn", "invisible"], hasTarget: true, make: () => ({ target: target() }) },
  { type: "assertText", label: "Assert exact text", icon: "❝", group: "Assertion", description: "Text khớp chính xác", keywords: ["assert", "text", "exact", "chữ", "nội dung", "verify"], hasTarget: true, make: () => ({ target: target("text"), expected: "" }) },
  { type: "assertContainsText", label: "Assert contains text", icon: "≋", group: "Assertion", description: "Text chứa chuỗi mong đợi", keywords: ["assert", "contains", "chứa", "text"], hasTarget: true, make: () => ({ target: target("text"), expected: "" }) },
  { type: "assertValue", label: "Assert field value", icon: "=✓", group: "Assertion", description: "Giá trị ô nhập", keywords: ["assert", "value", "giá trị", "input"], hasTarget: true, make: () => ({ target: target("label"), expected: "" }) },
  { type: "assertURL", label: "Assert URL", icon: "🔗✓", group: "Assertion", description: "Kiểm tra URL hiện tại", keywords: ["assert", "url", "địa chỉ"], hasTarget: false, make: () => ({ expected: "" }) },
  { type: "assertTitle", label: "Assert page title", icon: "T✓", group: "Assertion", description: "Kiểm tra tiêu đề trang", keywords: ["assert", "title", "tiêu đề"], hasTarget: false, make: () => ({ expected: "" }) },
  { type: "assertEnabled", label: "Assert enabled", icon: "⚡", group: "Assertion", description: "Phần tử ở trạng thái enabled", keywords: ["assert", "enabled", "bật"], hasTarget: true, make: () => ({ target: target() }) },
  { type: "assertDisabled", label: "Assert disabled", icon: "🚫", group: "Assertion", description: "Phần tử bị disabled", keywords: ["assert", "disabled", "tắt", "mờ"], hasTarget: true, make: () => ({ target: target() }) },
  { type: "assertChecked", label: "Assert checked", icon: "☑✓", group: "Assertion", description: "Checkbox đã tick", keywords: ["assert", "checked", "tick"], hasTarget: true, make: () => ({ target: target() }) },
  // -- Utility --
  { type: "screenshot", label: "Take screenshot", icon: "📷", group: "Utility", description: "Chụp ảnh màn hình", keywords: ["screenshot", "chụp", "ảnh", "capture", "photo"], hasTarget: false, make: () => ({ fullPage: false }) },
];

export const STEP_META: Record<string, StepMeta> = Object.fromEntries(
  STEP_CATALOG.map((m) => [m.type, m]),
);

export function createStep(type: string): BuilderStep {
  const meta = STEP_META[type];
  if (!meta) throw new Error(`Unknown step type: ${type}`);
  return { id: uid(), type, enabled: true, ...meta.make() };
}

// ------------------------------------------------------- readable summaries ---

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** "Button “Login”" instead of raw locator JSON (locator UX rule). */
export function targetSummary(spec: unknown): string {
  const l = (spec as LocatorSpec | undefined)?.primary;
  if (!l) return "element";
  switch (l.strategy) {
    case "role":
      return `${cap(l.role ?? "element")}${l.name ? ` “${l.name}”` : ""}`.trim();
    case "label":
      return `Field “${l.value ?? ""}”`;
    case "placeholder":
      return `Placeholder “${l.value ?? ""}”`;
    case "testId":
      return `Test ID “${l.value ?? ""}”`;
    case "text":
      return `Text “${l.value ?? ""}”`;
    case "css":
    case "xpath":
      return String(l.value ?? l.strategy);
    default:
      return "element";
  }
}

/** Business-readable card title, e.g. "Fill Email", "Click Login". */
export function businessName(step: BuilderStep): string {
  if (step.name) return step.name;
  const t = targetSummary((step as { target?: LocatorSpec }).target);
  switch (step.type) {
    case "goto":
      return `Navigate ${String(step.url ?? "") || "page"}`;
    case "reload":
      return "Reload page";
    case "goBack":
      return "Go back";
    case "goForward":
      return "Go forward";
    case "click":
      return `Click ${t}`;
    case "doubleClick":
      return `Double-click ${t}`;
    case "fill":
      return `Fill ${t}`;
    case "clear":
      return `Clear ${t}`;
    case "press":
      return `Press ${String(step.key ?? "")}`;
    case "check":
      return `Check ${t}`;
    case "uncheck":
      return `Uncheck ${t}`;
    case "select":
      return `Select ${t}`;
    case "hover":
      return `Hover ${t}`;
    case "waitForElement":
      return `Wait for ${t} (${String(step.state ?? "visible")})`;
    case "waitForTimeout":
      return `Wait ${String(step.milliseconds ?? 0)} ms`;
    case "waitForURL":
      return `Wait for URL ${String(step.url ?? step.pattern ?? "")}`;
    case "assertVisible":
      return `Assert ${t} visible`;
    case "assertHidden":
      return `Assert ${t} hidden`;
    case "assertText":
      return `Assert ${t} = “${String(step.expected ?? "")}”`;
    case "assertContainsText":
      return `Assert ${t} contains “${String(step.expected ?? "")}”`;
    case "assertValue":
      return `Assert ${t} value`;
    case "assertURL":
      return `Assert URL ${String(step.expected ?? step.pattern ?? "")}`;
    case "assertTitle":
      return `Assert title “${String(step.expected ?? "")}”`;
    case "assertEnabled":
      return `Assert ${t} enabled`;
    case "assertDisabled":
      return `Assert ${t} disabled`;
    case "assertChecked":
      return `Assert ${t} checked`;
    case "screenshot":
      return `Screenshot${step.name ? "" : String(step.fullPage ? " (full page)" : "")}`;
    default:
      return STEP_META[step.type]?.label ?? step.type;
  }
}

/** Advanced preview, e.g. getByRole('button', { name: 'Login' }). */
export function locatorPreview(spec: unknown): string {
  const l = (spec as LocatorSpec | undefined)?.primary;
  if (!l) return "—";
  switch (l.strategy) {
    case "role":
      return `getByRole('${l.role ?? ""}'${l.name ? `, { name: '${l.name}' }` : ""})`;
    case "label":
      return `getByLabel('${l.value ?? ""}')`;
    case "placeholder":
      return `getByPlaceholder('${l.value ?? ""}')`;
    case "testId":
      return `getByTestId('${l.value ?? ""}')`;
    case "text":
      return `getByText('${l.value ?? ""}')`;
    case "css":
      return `locator('${l.value ?? ""}')`;
    case "xpath":
      return `locator('xpath=${l.value ?? ""}')`;
    default:
      return JSON.stringify(l);
  }
}

export function searchCatalog(query: string): StepMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return STEP_CATALOG;
  return STEP_CATALOG.filter((m) =>
    [m.label, m.type, m.description, m.group, ...m.keywords]
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
}

// ------------------------------------------------------------- demo fallback ---

export function demoDefinition(id: string): BuilderDefinition {
  const mk = (type: string, extra: Record<string, unknown> = {}): BuilderStep => ({
    ...createStep(type),
    ...extra,
  });
  return {
    schemaVersion: "1.0",
    id,
    projectId: "demo",
    name: "Login flow (offline demo)",
    browser: "chromium",
    baseUrl: "https://example.com",
    variables: { EMAIL: "tester@example.com", PASSWORD: "secret" },
    steps: [
      mk("goto", { url: "/login" }),
      mk("fill", {
        name: "Fill Email",
        target: { primary: { strategy: "label", value: "Email" } },
        value: "{{EMAIL}}",
      }),
      mk("fill", {
        name: "Fill Password",
        target: { primary: { strategy: "label", value: "Password" } },
        value: "{{PASSWORD}}",
        sensitive: true,
      }),
      mk("click", {
        name: "Click Login",
        target: { primary: { strategy: "role", role: "button", name: "Login" } },
      }),
      mk("assertText", {
        name: "Assert Dashboard",
        target: { primary: { strategy: "role", role: "heading", name: "Dashboard" } },
        expected: "Dashboard",
      }),
    ],
  };
}

// ------------------------------------------------------- code preview (tab) ---

export function toPlaywrightPreview(def: BuilderDefinition): string {
  const lines = [
    `// Preview (generated code is output-only, never edited here)`,
    `import { test, expect } from '@playwright/test';`,
    ``,
    `test('${def.name.replace(/'/g, "\\'")}', async ({ page }) => {`,
  ];
  for (const s of def.steps) {
    if (!s.enabled) continue;
    const tgt = (s as { target?: LocatorSpec }).target;
    const loc = tgt ? `page.${locatorPreview(tgt).replace(/^get/, "get")}` : null;
    switch (s.type) {
      case "goto":
        lines.push(`  await page.goto('${s.url ?? ""}');`);
        break;
      case "reload":
        lines.push(`  await page.reload();`);
        break;
      case "goBack":
        lines.push(`  await page.goBack();`);
        break;
      case "goForward":
        lines.push(`  await page.goForward();`);
        break;
      case "click":
        lines.push(`  await ${loc}.click();`);
        break;
      case "doubleClick":
        lines.push(`  await ${loc}.dblclick();`);
        break;
      case "fill":
        lines.push(`  await ${loc}.fill('${String(s.value ?? "").replace(/'/g, "\\'")}');`);
        break;
      case "clear":
        lines.push(`  await ${loc}.clear();`);
        break;
      case "press":
        lines.push(`  await ${(loc ?? "page.keyboard")}.press('${s.key ?? "Enter"}');`);
        break;
      case "check":
        lines.push(`  await ${loc}.check();`);
        break;
      case "uncheck":
        lines.push(`  await ${loc}.uncheck();`);
        break;
      case "select":
        lines.push(`  await ${loc}.selectOption('${String(s.value ?? "")}');`);
        break;
      case "hover":
        lines.push(`  await ${loc}.hover();`);
        break;
      case "waitForElement":
        lines.push(`  await ${loc}.waitFor({ state: '${s.state ?? "visible"}' });`);
        break;
      case "waitForTimeout":
        lines.push(`  await page.waitForTimeout(${Number(s.milliseconds ?? 0)}); // use only when necessary`);
        break;
      case "waitForURL":
        lines.push(`  await page.waitForURL('${s.url ?? s.pattern ?? ""}');`);
        break;
      case "assertVisible":
        lines.push(`  await expect(${loc}).toBeVisible();`);
        break;
      case "assertHidden":
        lines.push(`  await expect(${loc}).toBeHidden();`);
        break;
      case "assertText":
        lines.push(`  await expect(${loc}).toHaveText('${String(s.expected ?? "")}');`);
        break;
      case "assertContainsText":
        lines.push(`  await expect(${loc}).toContainText('${String(s.expected ?? "")}');`);
        break;
      case "assertValue":
        lines.push(`  await expect(${loc}).toHaveValue('${String(s.expected ?? "")}');`);
        break;
      case "assertURL":
        lines.push(`  await expect(page).toHaveURL('${s.expected ?? s.pattern ?? ""}');`);
        break;
      case "assertTitle":
        lines.push(`  await expect(page).toHaveTitle('${String(s.expected ?? "")}');`);
        break;
      case "assertEnabled":
        lines.push(`  await expect(${loc}).toBeEnabled();`);
        break;
      case "assertDisabled":
        lines.push(`  await expect(${loc}).toBeDisabled();`);
        break;
      case "assertChecked":
        lines.push(`  await expect(${loc}).toBeChecked();`);
        break;
      case "screenshot":
        lines.push(`  await page.screenshot({ fullPage: ${s.fullPage ? "true" : "false"} });`);
        break;
      default:
        lines.push(`  // unknown step: ${s.type}`);
    }
  }
  lines.push(`});`);
  return lines.join("\n");
}
