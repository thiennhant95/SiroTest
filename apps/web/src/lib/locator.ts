/**
 * Web-side locator presentation helpers (Day 5-6: Locator picker).
 *
 * Single source of truth for expressions + 0/1/N semantics is
 * packages/locator-engine — imported directly from source so web and
 * engine can never drift (same mapping as 06-compiler/playwright-compiler.md).
 */
import {
  candidateToExpression,
  testLocatorMatch,
} from "../../../../packages/locator-engine/src/index";
import type {
  LocatorCandidate,
  TestLocatorResult,
} from "../../../../packages/locator-engine/src/index";

export type { LocatorCandidate, TestLocatorResult };
export { candidateToExpression, testLocatorMatch };

const ROLE_LABELS: Record<string, string> = {
  button: "Button",
  textbox: "Textbox",
  searchbox: "Search field",
  link: "Link",
  checkbox: "Checkbox",
  radio: "Radio",
  combobox: "Dropdown",
  listbox: "List",
  heading: "Heading",
  img: "Image",
  switch: "Switch",
  tab: "Tab",
  menuitem: "Menu item",
};

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? cap(role);
}

function truncate(s: string, max = 40): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Human-readable target summary for LocatorBadge (10-ui-ux/visual-builder.md):
 * `Button "Login"` instead of raw JSON. Advanced <details> shows the exact
 * Playwright expression via candidateToExpression (toExpression.ts).
 */
export function humanizeLocator(c: LocatorCandidate): string {
  switch (c.strategy) {
    case "role":
      return c.name
        ? `${roleLabel(c.role)} "${c.name}"`
        : `${roleLabel(c.role)}`;
    case "label":
      return `Field "${c.value}"`;
    case "placeholder":
      return `Field "${c.value}"`;
    case "testId":
      return `Test ID "${c.value}"`;
    case "text":
      return `Text "${c.value}"`;
    case "css":
      return `Element "${truncate(c.value)}"`;
    case "xpath":
      return `Element "${truncate(c.value)}"`;
  }
}

/** Steps whose action/assertion legitimately permits N matches (warning only). */
export const MULTI_ALLOWED_TYPES = new Set<string>(["waitForElement"]);

export function isMultiAllowed(stepType: string): boolean {
  return MULTI_ALLOWED_TYPES.has(stepType);
}

/** Client-side 0/1/N evaluation mirroring engine.testLocatorMatch. */
export function evaluateForSave(
  matchCount: number,
  stepType: string,
): TestLocatorResult {
  return testLocatorMatch(matchCount, {
    allowMultiple: isMultiAllowed(stepType),
  });
}
