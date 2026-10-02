/**
 * Fixture steps + pick targets for testing pickers without a live browser.
 * Steps mirror examples/login-test.json; targets mirror its locator engine
 * output (primary + alternatives, P0 executes primary only).
 */
import type { LocatorCandidate } from "../lib/locator";
import type { BuilderStep } from "./types";

export function newStepId(prefix = "s"): string {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`;
}

export function sampleLoginSteps(): BuilderStep[] {
  return [
    { id: "s1", type: "goto", name: "Open login page", enabled: true, url: "{{BASE_URL}}/login" },
    {
      id: "s2", type: "fill", name: "Fill email", enabled: true,
      target: { primary: { strategy: "label", value: "Email" } },
      value: "{{ADMIN_EMAIL}}",
    },
    {
      id: "s3", type: "fill", name: "Fill password", enabled: true,
      target: { primary: { strategy: "label", value: "Password" } },
      value: "{{ADMIN_PASSWORD}}",
    },
    {
      id: "s4", type: "click", name: "Submit login", enabled: true,
      target: {
        primary: { strategy: "role", role: "button", name: "Login" },
        alternatives: [
          { strategy: "text", value: "Login" },
          { strategy: "css", value: "button.login" },
        ],
      },
    },
    {
      id: "s5", type: "assertVisible", name: "Dashboard shows", enabled: true,
      target: { primary: { strategy: "text", value: "Dashboard" } },
    },
  ];
}

export interface FixtureTarget {
  label: string;
  primary: LocatorCandidate;
  alternatives: LocatorCandidate[];
}

/** "Simulate pick" presets used by both picker modals in fixture mode. */
export const FIXTURE_TARGETS: FixtureTarget[] = [
  {
    label: "Login button",
    primary: { strategy: "role", role: "button", name: "Login" },
    alternatives: [
      { strategy: "text", value: "Login" },
      { strategy: "css", value: "button.login" },
    ],
  },
  {
    label: "Email field",
    primary: { strategy: "label", value: "Email" },
    alternatives: [
      { strategy: "placeholder", value: "you@example.com" },
      { strategy: "css", value: "input#email" },
    ],
  },
  {
    label: "Dashboard heading",
    primary: { strategy: "text", value: "Dashboard" },
    alternatives: [{ strategy: "role", role: "heading", name: "Dashboard" }],
  },
];

/** Serialize builder steps to TestDefinition steps for PATCH /tests/:id. */
export function toDefinitionSteps(steps: BuilderStep[]): Record<string, unknown>[] {
  return steps.map((s) => {
    const out: Record<string, unknown> = {
      id: s.id,
      type: s.type,
      enabled: s.enabled,
    };
    if (s.name) out.name = s.name;
    if (s.target) out.target = s.target;
    if (s.value !== undefined) out.value = s.value;
    if (s.expected !== undefined) out.expected = s.expected;
    if (s.url !== undefined) out.url = s.url;
    return out;
  });
}
