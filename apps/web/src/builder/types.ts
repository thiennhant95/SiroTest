/**
 * Builder step model (Day 5-6). Mirrors 03-test-model/test-definition.md +
 * step-catalog.md; LocatorSpec shape matches packages/locator-engine types
 * (primary executed, alternatives stored evidence only).
 */
import type { LocatorCandidate } from "../lib/locator";

export interface LocatorSpec {
  primary: LocatorCandidate;
  alternatives?: LocatorCandidate[];
}

export interface BuilderStep {
  id: string;
  type: string;
  name?: string;
  enabled: boolean;
  target?: LocatorSpec | null;
  value?: string;
  expected?: string;
  url?: string;
}

/** Steps that bear a locator and get the LocatorBadge + Test UI. */
export const LOCATOR_STEP_TYPES = new Set<string>([
  "click",
  "doubleClick",
  "fill",
  "clear",
  "press",
  "check",
  "uncheck",
  "select",
  "hover",
  "waitForElement",
  "assertVisible",
  "assertHidden",
  "assertText",
  "assertContainsText",
  "assertValue",
  "assertEnabled",
  "assertDisabled",
  "assertChecked",
]);

export function bearsLocator(stepType: string): boolean {
  return LOCATOR_STEP_TYPES.has(stepType);
}

export interface AssertionOption {
  type: string;
  label: string;
  hint: string;
  needsTarget: boolean;
  needsExpected: boolean;
  expectedPlaceholder?: string;
}

/** Flow B proposal set (01-product/user-flows.md) + URL/Title (acceptance min). */
export const ASSERTION_OPTIONS: AssertionOption[] = [
  { type: "assertVisible", label: "Visible", hint: "Element is visible", needsTarget: true, needsExpected: false },
  { type: "assertHidden", label: "Hidden", hint: "Element is hidden", needsTarget: true, needsExpected: false },
  { type: "assertText", label: "Text equals", hint: "Exact text match", needsTarget: true, needsExpected: true, expectedPlaceholder: "Welcome back" },
  { type: "assertContainsText", label: "Text contains", hint: "Substring match", needsTarget: true, needsExpected: true, expectedPlaceholder: "Welcome" },
  { type: "assertValue", label: "Value", hint: "Input value equals", needsTarget: true, needsExpected: true, expectedPlaceholder: "admin@example.com" },
  { type: "assertEnabled", label: "Enabled", hint: "Control is enabled", needsTarget: true, needsExpected: false },
  { type: "assertDisabled", label: "Disabled", hint: "Control is disabled", needsTarget: true, needsExpected: false },
  { type: "assertChecked", label: "Checked", hint: "Checkbox/radio is checked", needsTarget: true, needsExpected: false },
  { type: "assertURL", label: "URL", hint: "Page URL equals/pattern", needsTarget: false, needsExpected: true, expectedPlaceholder: "https://staging.example.com/dashboard" },
  { type: "assertTitle", label: "Title", hint: "Page title equals", needsTarget: false, needsExpected: true, expectedPlaceholder: "Dashboard" },
];

/** Last "Test locator" outcome per step; gates healthy save (0/1/N). */
export interface StepTestResult {
  matchCount: number;
  status: "none" | "unique" | "ambiguous";
  canSave: boolean;
  message: string;
  warning?: string;
}
