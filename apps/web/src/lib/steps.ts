/**
 * Step catalog metadata for the visual builder.
 * Sources: spec/03-test-model/step-catalog.md + packages/test-model/src/types.ts.
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
  /** P1 â€” free-form tags (filter in test list; PATCH definition.tags). */
  tags?: string[];
  variables?: Record<string, string>;
  /** P1 â€” embedded data tables for data-driven runs (CSV/JSON import). */
  datasets?: BuilderDataSet[];
  steps: BuilderStep[];
}

/** P1 â€” one named table of plaintext rows (never secrets â€” see Datasets tab hint). */
export interface BuilderDataSet {
  id: string;
  name: string;
  rows: Record<string, string>[];
}

/** P1 â€” a named parameter of a reusable action. */
export interface BuilderActionParameter {
  name: string;
  description?: string;
  /** Used when the caller omits the argument. */
  default?: string;
  /** Secret params resolve at run time and are redacted like variables. */
  secret?: boolean;
}

/** P1 â€” reusable business action (project-scoped; body is P0 steps only). */
export interface BuilderAction {
  schemaVersion: "1.0";
  id: string;
  projectId: string;
  name: string;
  description?: string;
  parameters: BuilderActionParameter[];
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
  { type: "goto", label: "Go to page", icon: "â†’", group: "Navigation", description: "Open a URL", keywords: ["goto", "navigate", "url", "trang", "má»Ÿ", "Ä‘iá»u hÆ°á»›ng", "open", "page"], hasTarget: false, make: () => ({ url: "/login" }) },
  { type: "reload", label: "Reload page", icon: "â†»", group: "Navigation", description: "Reload the page", keywords: ["reload", "refresh", "táº£i láº¡i", "refresh"], hasTarget: false, make: () => ({}) },
  { type: "goBack", label: "Go back", icon: "â†", group: "Navigation", description: "Go back to the previous page", keywords: ["back", "quay láº¡i", "history"], hasTarget: false, make: () => ({}) },
  { type: "goForward", label: "Go forward", icon: "â†’", group: "Navigation", description: "Go forward to the next page", keywords: ["forward", "tiáº¿n", "history"], hasTarget: false, make: () => ({}) },
  // -- Interaction --
  { type: "click", label: "Click", icon: "ðŸ‘†", group: "Interaction", description: "Click an element", keywords: ["click", "nháº¥n", "nháº¥p", "button", "nÃºt", "press", "tap"], hasTarget: true, make: () => ({ target: target() }) },
  { type: "doubleClick", label: "Double click", icon: "ðŸ‘†ðŸ‘†", group: "Interaction", description: "Double-click an element", keywords: ["double", "nháº¥p Ä‘Ãºp", "doubleclick"], hasTarget: true, make: () => ({ target: target() }) },
  { type: "fill", label: "Fill text field", icon: "âœŽ", group: "Interaction", description: "Fill a text input", keywords: ["fill", "Ä‘iá»n", "nháº­p", "email", "text", "textbox", "field", "input", "type"], hasTarget: true, make: () => ({ target: target("label"), value: "" }) },
  { type: "clear", label: "Clear field", icon: "âŒ«", group: "Interaction", description: "Clear an input", keywords: ["clear", "xÃ³a", "empty"], hasTarget: true, make: () => ({ target: target("label") }) },
  { type: "press", label: "Press key", icon: "âŒ¨", group: "Interaction", description: "Press a key (Enter, Tabâ€¦)", keywords: ["press", "key", "phÃ­m", "enter", "tab", "keyboard"], hasTarget: false, make: () => ({ key: "Enter" }) },
  { type: "check", label: "Check checkbox", icon: "â˜‘", group: "Interaction", description: "Check a checkbox", keywords: ["check", "tick", "checkbox", "chá»n"], hasTarget: true, make: () => ({ target: target() }) },
  { type: "uncheck", label: "Uncheck checkbox", icon: "â˜", group: "Interaction", description: "Uncheck a checkbox", keywords: ["uncheck", "untick", "bá» chá»n", "checkbox"], hasTarget: true, make: () => ({ target: target() }) },
  { type: "select", label: "Select option", icon: "â–¾", group: "Interaction", description: "Select a dropdown option", keywords: ["select", "dropdown", "option", "chá»n", "combobox"], hasTarget: true, make: () => ({ target: target("label"), value: "" }) },
  { type: "hover", label: "Hover", icon: "â—ˆ", group: "Interaction", description: "Hover over an element", keywords: ["hover", "di chuá»™t", "mouse"], hasTarget: true, make: () => ({ target: target() }) },
  // -- Wait --
  { type: "waitForElement", label: "Wait for element", icon: "â³", group: "Wait", description: "Wait for an element state", keywords: ["wait", "chá»", "element", "visible", "state"], hasTarget: true, make: () => ({ target: target(), state: "visible" }) },
  { type: "waitForTimeout", label: "Fixed wait", icon: "â±", group: "Wait", description: "Wait a fixed N milliseconds", keywords: ["wait", "timeout", "sleep", "chá»", "giÃ¢y", "fixed", "delay"], hasTarget: false, warnFixedWait: true, make: () => ({ milliseconds: 1000 }) },
  { type: "waitForURL", label: "Wait for URL", icon: "ðŸ”—", group: "Wait", description: "Wait for the URL to match a pattern", keywords: ["wait", "url", "chá»", "redirect", "pattern"], hasTarget: false, make: () => ({ url: "" }) },
  // -- Assertions --
  { type: "assertVisible", label: "Assert visible", icon: "âœ“", group: "Assertion", description: "Assert an element is visible", keywords: ["assert", "visible", "hiá»ƒn thá»‹", "check", "verify", "tháº¥y"], hasTarget: true, make: () => ({ target: target() }) },
  { type: "assertHidden", label: "Assert hidden", icon: "âœ•", group: "Assertion", description: "Assert an element is hidden", keywords: ["assert", "hidden", "áº©n", "invisible"], hasTarget: true, make: () => ({ target: target() }) },
  { type: "assertText", label: "Assert exact text", icon: "â", group: "Assertion", description: "Exact text match", keywords: ["assert", "text", "exact", "chá»¯", "ná»™i dung", "verify"], hasTarget: true, make: () => ({ target: target("text"), expected: "" }) },
  { type: "assertContainsText", label: "Assert contains text", icon: "â‰‹", group: "Assertion", description: "Text contains the expected string", keywords: ["assert", "contains", "chá»©a", "text"], hasTarget: true, make: () => ({ target: target("text"), expected: "" }) },
  { type: "assertValue", label: "Assert field value", icon: "=âœ“", group: "Assertion", description: "Input field value", keywords: ["assert", "value", "giÃ¡ trá»‹", "input"], hasTarget: true, make: () => ({ target: target("label"), expected: "" }) },
  { type: "assertURL", label: "Assert URL", icon: "ðŸ”—âœ“", group: "Assertion", description: "Check the current URL", keywords: ["assert", "url", "Ä‘á»‹a chá»‰"], hasTarget: false, make: () => ({ expected: "" }) },
  { type: "assertTitle", label: "Assert page title", icon: "Tâœ“", group: "Assertion", description: "Check the page title", keywords: ["assert", "title", "tiÃªu Ä‘á»"], hasTarget: false, make: () => ({ expected: "" }) },
  { type: "assertEnabled", label: "Assert enabled", icon: "âš¡", group: "Assertion", description: "Element is enabled", keywords: ["assert", "enabled", "báº­t"], hasTarget: true, make: () => ({ target: target() }) },
  { type: "assertDisabled", label: "Assert disabled", icon: "ðŸš«", group: "Assertion", description: "Element is disabled", keywords: ["assert", "disabled", "táº¯t", "má»"], hasTarget: true, make: () => ({ target: target() }) },
  { type: "assertChecked", label: "Assert checked", icon: "â˜‘âœ“", group: "Assertion", description: "Checkbox is checked", keywords: ["assert", "checked", "tick"], hasTarget: true, make: () => ({ target: target() }) },
  // -- Utility --
  { type: "screenshot", label: "Take screenshot", icon: "ðŸ“·", group: "Utility", description: "Take a screenshot", keywords: ["screenshot", "chá»¥p", "áº£nh", "capture", "photo"], hasTarget: false, make: () => ({ fullPage: false }) },
  // -- P1 reusable action invocation (business keyword; body inlines at compile time) --
  { type: "callAction", label: "Call action", icon: "ðŸ”", group: "Utility", description: "Call a reusable action (business keyword)", keywords: ["call", "action", "reusable", "gá»i", "keyword", "business", "tÃ¡i sá»­ dá»¥ng"], hasTarget: false, make: () => ({ actionId: "", arguments: {} }) },
  // -- P1 wave 2: files / tabs / dialogs / API (shapes mirror packages/test-model) --
  { type: "upload", label: "Upload file", icon: "ðŸ“¤", group: "Interaction", description: "Upload a file via an input", keywords: ["upload", "táº£i lÃªn", "tai len", "file", "input", "setinputfiles", "Ä‘Ã­nh kÃ¨m", "dinh kem"], hasTarget: true, make: () => ({ target: target(), fileId: "" }) },
  { type: "download", label: "Download file", icon: "ðŸ“¥", group: "Utility", description: "Click to download a file / download directly from a URL", keywords: ["download", "táº£i xuá»‘ng", "tai xuong", "save", "lÆ°u", "luu", "táº£i file", "tai file"], hasTarget: true, make: () => ({ url: "", saveAs: "" }) },
  { type: "newTab", label: "Open new tab", icon: "ðŸ——", group: "Navigation", description: "Open a new tab (with optional URL)", keywords: ["new tab", "tab má»›i", "tab moi", "má»Ÿ tab", "mo tab", "window", "popup"], hasTarget: false, make: () => ({ url: "" }) },
  { type: "closeTab", label: "Close tab", icon: "âœ•", group: "Navigation", description: "Close the current tab", keywords: ["close tab", "Ä‘Ã³ng tab", "dong tab", "close", "window", "Ä‘Ã³ng"], hasTarget: false, make: () => ({}) },
  { type: "handleDialog", label: "Handle dialog", icon: "ðŸ’¬", group: "Utility", description: "Handle the next alert/confirm/prompt dialog", keywords: ["dialog", "há»™p thoáº¡i", "hop thoai", "alert", "confirm", "prompt", "accept", "dismiss", "popup"], hasTarget: false, make: () => ({ action: "accept" }) },
  { type: "apiRequest", label: "API request", icon: "ðŸŒ", group: "Utility", description: "Call an HTTP API and check the status", keywords: ["api", "request", "http", "get", "post", "put", "patch", "delete", "rest", "gá»i api", "goi api"], hasTarget: false, make: () => ({ method: "GET", url: "", expectedStatus: 200 }) },
  { type: "mockRoute", label: "Mock API route", icon: "ðŸŽ­", group: "Utility", description: "Mock an API response to test error UI (place before goto/click)", keywords: ["mock", "giáº£", "gia", "route", "intercept", "fulfill", "stub", "fake api", "lá»—i api", "loi api", "500", "offline"], hasTarget: false, make: () => ({ url: "", status: 500, body: '{"error":"mocked"}', contentType: "application/json" }) },
  { type: "axeCheck", label: "Accessibility scan", icon: "â™¿", group: "Assertion", description: "Run an axe-core scan (WCAG) â€” fails on critical/serious issues", keywords: ["axe", "accessibility", "a11y", "wcag", "contrast", "tÆ°Æ¡ng pháº£n", "khuyáº¿t táº­t", "scan", "quÃ©t"], hasTarget: false, make: () => ({}) },
  // -- P2 visual regression (target OPTIONAL: whole viewport when omitted) --
  { type: "visualCheck", label: "Visual check", icon: "ðŸ“¸", group: "Assertion", description: "Compare against a saved baseline", keywords: ["visual", "baseline", "regression", "screenshot", "compare", "so sÃ¡nh", "áº£nh", "giao diá»‡n", "há»“i quy"], hasTarget: true, make: () => ({ name: "", threshold: 0.05 }) },
  // -- P2 plugin step fallback (manual type; dynamic per-plugin entries come from GET /plugins) --
  { type: "plugin:", label: "Plugin stepâ€¦", icon: "ðŸ”Œ", group: "Utility", description: "Plugin step (enter the full plugin:â€¦ type)", keywords: ["plugin", "custom", "extension", "sdk", "má»Ÿ rá»™ng"], hasTarget: false, make: () => ({ params: {} }) },
];

/** A step type is plugin-provided when it uses the `plugin:` prefix. */
export function isPluginStepType(type: string): boolean {
  return type.startsWith("plugin:") && type.length > "plugin:".length;
}

/**
 * Build dynamic catalog entries from GET /plugins metadata (PluginDocs shape).
 * Unknown/custom types still work via the static `plugin:` fallback entry.
 */
export function pluginCatalogEntries(plugins: Array<{
  name: string;
  steps: Array<{ type: string; description?: string }>;
}>): StepMeta[] {
  return plugins.flatMap((p) =>
    p.steps.map((s) => ({
      type: s.type,
      label: s.type,
      icon: "ðŸ”Œ",
      group: "Utility" as StepGroup,
      description: s.description ?? `Plugin ${p.name}`,
      keywords: ["plugin", p.name, s.type],
      hasTarget: false,
      make: () => ({ params: {} }),
    })),
  );
}

/** Create a step for an arbitrary (e.g. plugin:) type without a catalog entry. */
export function createCustomStep(type: string): BuilderStep {
  const t = type.trim();
  if (!isPluginStepType(t)) throw new Error(`Unknown step type: ${type}`);
  return { id: uid(), type: t, enabled: true, params: {} };
}

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

/** "Button â€œLoginâ€" instead of raw locator JSON (locator UX rule). */
export function targetSummary(spec: unknown): string {
  const l = (spec as LocatorSpec | undefined)?.primary;
  if (!l) return "element";
  switch (l.strategy) {
    case "role":
      return `${cap(l.role ?? "element")}${l.name ? ` â€œ${l.name}â€` : ""}`.trim();
    case "label":
      return `Field â€œ${l.value ?? ""}â€`;
    case "placeholder":
      return `Placeholder â€œ${l.value ?? ""}â€`;
    case "testId":
      return `Test ID â€œ${l.value ?? ""}â€`;
    case "text":
      return `Text â€œ${l.value ?? ""}â€`;
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
      return `Assert ${t} = â€œ${String(step.expected ?? "")}â€`;
    case "assertContainsText":
      return `Assert ${t} contains â€œ${String(step.expected ?? "")}â€`;
    case "assertValue":
      return `Assert ${t} value`;
    case "assertURL":
      return `Assert URL ${String(step.expected ?? step.pattern ?? "")}`;
    case "assertTitle":
      return `Assert title â€œ${String(step.expected ?? "")}â€`;
    case "assertEnabled":
      return `Assert ${t} enabled`;
    case "assertDisabled":
      return `Assert ${t} disabled`;
    case "assertChecked":
      return `Assert ${t} checked`;
    case "screenshot":
      return `Screenshot${step.name ? "" : String(step.fullPage ? " (full page)" : "")}`;
    case "callAction": {
      const aid = typeof step.actionId === "string" ? step.actionId : "";
      const args = step.arguments as Record<string, string> | undefined;
      const n = args ? Object.keys(args).length : 0;
      return `Call action ${aid ? `â€œ${aid.slice(0, 24)}â€` : "(not selected)"}${n > 0 ? ` (${n} arg${n > 1 ? "s" : ""})` : ""}`;
    }
    case "upload":
      return `Upload ${typeof step.fileId === "string" && step.fileId ? `file â€œ${String(step.fileId).slice(0, 18)}â€` : "file"} to ${t}`;
    case "download": {
      const u = typeof step.url === "string" ? step.url : "";
      const s = typeof step.saveAs === "string" ? step.saveAs : "";
      if (u) return `Download ${u}${s ? ` â†’ ${s}` : ""}`;
      return `Download via ${t}${s ? ` â†’ ${s}` : ""}`;
    }
    case "newTab": {
      const u = typeof step.url === "string" ? step.url : "";
      return u ? `Open new tab ${u}` : "Open new tab";
    }
    case "closeTab":
      return "Close tab";
    case "handleDialog": {
      const a = typeof step.action === "string" ? step.action : "accept";
      const p = typeof step.promptText === "string" && step.promptText ? ` â€œ${step.promptText}â€` : "";
      return `Handle dialog: ${a}${p}`;
    }
    case "apiRequest": {
      const m = typeof step.method === "string" ? step.method : "GET";
      const u = typeof step.url === "string" ? step.url : "";
      return `${m} ${u || "(no URL entered)"}`;
    }
    case "visualCheck": {
      const n = typeof step.name === "string" && step.name ? `â€œ${step.name}â€` : "(no baseline name)";
      const th = typeof step.threshold === "number" ? ` Â· ${(step.threshold * 100).toFixed(1)}%` : "";
      const scope = (step as { target?: unknown }).target ? ` Â· ${t}` : " Â· whole page";
      return `Visual check ${n}${th}${scope}`;
    }
    default:
      if (isPluginStepType(step.type)) {
        const params = step.params as Record<string, unknown> | undefined;
        const n = params ? Object.keys(params).length : 0;
        return `${step.type}${n > 0 ? ` (${n} param${n > 1 ? "s" : ""})` : ""}`;
      }
      return STEP_META[step.type]?.label ?? "Custom step";
  }
}

/** Advanced preview, e.g. getByRole('button', { name: 'Login' }). */
export function locatorPreview(spec: unknown): string {
  const l = (spec as LocatorSpec | undefined)?.primary;
  if (!l) return "â€”";
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
      case "callAction": {
        const aid = typeof s.actionId === "string" ? s.actionId : "";
        const args = s.arguments as Record<string, unknown> | undefined;
        const keys = args ? Object.keys(args) : [];
        lines.push(`  // call action '${aid}' (inlined at compile time)${keys.length > 0 ? ` with ${keys.length} arg(s): ${keys.join(", ")}` : ""};`);
        break;
      }
      case "upload":
        lines.push(`  await ${loc}.setInputFiles('${String(s.fileId ?? "").replace(/'/g, "\\'")}'); // file store id`);
        break;
      case "download": {
        const url = typeof s.url === "string" ? s.url : "";
        const saveAs = typeof s.saveAs === "string" && s.saveAs ? ` // save as ${s.saveAs}` : "";
        if (url) lines.push(`  // download from URL${saveAs}\n  await page.goto('${url.replace(/'/g, "\\'")}');${saveAs}`);
        else lines.push(`  const downloadPromise = page.waitForEvent('download');\n  await ${loc}.click();\n  const download = await downloadPromise;${saveAs}`);
        break;
      }
      case "newTab": {
        const url = typeof s.url === "string" ? s.url : "";
        if (url) lines.push(`  const page1 = await context.newPage();\n  await page1.goto('${url.replace(/'/g, "\\'")}');`);
        else lines.push(`  const page1 = await context.newPage();`);
        break;
      }
      case "closeTab":
        lines.push(`  await page.close(); // fails explicitly when it is the last tab`);
        break;
      case "handleDialog": {
        const action = s.action === "dismiss" ? "dismiss" : "accept";
        const prompt = typeof s.promptText === "string" && s.promptText ? `, "${s.promptText.replace(/"/g, '\\"')}"` : "";
        lines.push(`  page.once('dialog', (d) => d.${action}(${prompt.startsWith(", ") ? prompt.slice(2) : ""})); // next dialog only`);
        break;
      }
      case "apiRequest": {
        const method = typeof s.method === "string" ? s.method : "GET";
        const url = typeof s.url === "string" ? s.url.replace(/'/g, "\\'") : "";
        const headers = s.headers as Record<string, string> | undefined;
        const headerEntries = headers ? Object.entries(headers) : [];
        const body = typeof s.body === "string" && s.body ? `, data: ${JSON.stringify(s.body)}` : "";
        const headerArg = headerEntries.length > 0 ? `, headers: ${JSON.stringify(Object.fromEntries(headerEntries))}` : "";
        const exp = typeof s.expectedStatus === "number" ? s.expectedStatus : undefined;
        const saveAs = typeof s.saveAs === "string" && s.saveAs ? s.saveAs : "";
        lines.push(`  const resp = await request.${method.toLowerCase()}('${url}'${headerArg}${body});`);
        if (exp !== undefined) lines.push(`  expect(resp.status()).toBe(${exp}); // fail explicit khi sai status`);
        lines.push(`  ${saveAs ? `const ${saveAs} = await resp.text(); // run variable` : "await resp.text();"}`);
        break;
      }
      case "visualCheck": {
        const vname = typeof s.name === "string" && s.name ? s.name.replace(/'/g, "\\'") : "visual";
        const threshold = typeof s.threshold === "number" ? s.threshold : 0.05;
        const vloc = loc ? `${loc}` : "page";
        lines.push(`  await expect(${vloc}).toHaveScreenshot('${vname}.png', { maxDiffPixelRatio: ${threshold} });`);
        break;
      }
      default:
        if (typeof s.type === "string" && s.type.startsWith("plugin:")) {
          const params = s.params as Record<string, unknown> | undefined;
          lines.push(`  // ${s.type} is a server-side plugin step (ALLOW_PLUGINS=1) â€” no client preview;`);
          lines.push(`  // executed by plugin code with params ${JSON.stringify(params ?? {})}.`);
        } else {
          lines.push(`  // unknown step: ${s.type}`);
        }
    }
  }
  lines.push(`});`);
  return lines.join("\n");
}
