/**
 * Zod validators for the P0 test-model.
 *
 * Principles:
 * - No silent mutation: pure `zod` parsing, no `.transform()`, no `.default()`,
 *   no `z.coerce.*`. What fails validation throws; what passes is returned as a
 *   new object by zod (input is never mutated in place).
 * - `schemaVersion` must be the explicit literal `"1.0"`. Older/newer versions
 *   are rejected here — route them through `migrateTestDefinition()` first.
 */
import { z } from "zod";

// ------------------------------------------------------------ primitives ---

const baseStep = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1).optional(),
  enabled: z.boolean(),
  timeoutMs: z.number().int().positive().optional(),
  continueOnFailure: z.boolean().optional(),
});

// -------------------------------------------------------------- locator ---

const roleCandidate = z.object({
  strategy: z.literal("role"),
  role: z.string().min(1),
  name: z.string().optional(),
  exact: z.boolean().optional(),
});
const labelCandidate = z.object({
  strategy: z.literal("label"),
  value: z.string().min(1),
  exact: z.boolean().optional(),
});
const placeholderCandidate = z.object({
  strategy: z.literal("placeholder"),
  value: z.string().min(1),
  exact: z.boolean().optional(),
});
const testIdCandidate = z.object({
  strategy: z.literal("testId"),
  value: z.string().min(1),
});
const textCandidate = z.object({
  strategy: z.literal("text"),
  value: z.string().min(1),
  exact: z.boolean().optional(),
});
const cssCandidate = z.object({
  strategy: z.literal("css"),
  value: z.string().min(1),
});
const xpathCandidate = z.object({
  strategy: z.literal("xpath"),
  value: z.string().min(1),
});

export const locatorCandidateSchema = z.discriminatedUnion("strategy", [
  roleCandidate,
  labelCandidate,
  placeholderCandidate,
  testIdCandidate,
  textCandidate,
  cssCandidate,
  xpathCandidate,
]);

export const locatorSpecSchema = z.object({
  primary: locatorCandidateSchema,
  alternatives: z.array(locatorCandidateSchema).optional(),
});

// ----------------------------------------------------------------- steps ---

const gotoStep = baseStep.extend({
  type: z.literal("goto"),
  url: z.string().min(1),
});
const reloadStep = baseStep.extend({ type: z.literal("reload") });
const goBackStep = baseStep.extend({ type: z.literal("goBack") });
const goForwardStep = baseStep.extend({ type: z.literal("goForward") });

const clickStep = baseStep.extend({
  type: z.literal("click"),
  target: locatorSpecSchema,
});
const doubleClickStep = baseStep.extend({
  type: z.literal("doubleClick"),
  target: locatorSpecSchema,
});
const fillStep = baseStep.extend({
  type: z.literal("fill"),
  target: locatorSpecSchema,
  value: z.string(),
  sensitive: z.boolean().optional(),
});
const clearStep = baseStep.extend({
  type: z.literal("clear"),
  target: locatorSpecSchema,
});
const pressStep = baseStep.extend({
  type: z.literal("press"),
  target: locatorSpecSchema.optional(),
  key: z.string().min(1),
});
const checkStep = baseStep.extend({
  type: z.literal("check"),
  target: locatorSpecSchema,
});
const uncheckStep = baseStep.extend({
  type: z.literal("uncheck"),
  target: locatorSpecSchema,
});
const selectStep = baseStep.extend({
  type: z.literal("select"),
  target: locatorSpecSchema,
  value: z.string(),
});
const hoverStep = baseStep.extend({
  type: z.literal("hover"),
  target: locatorSpecSchema,
});

const waitForElementStep = baseStep.extend({
  type: z.literal("waitForElement"),
  target: locatorSpecSchema,
  state: z.enum(["attached", "detached", "visible", "hidden"]),
});
const waitForTimeoutStep = baseStep.extend({
  type: z.literal("waitForTimeout"),
  milliseconds: z.number().int().nonnegative(),
});
const waitForURLStep = baseStep.extend({
  type: z.literal("waitForURL"),
  url: z.string().min(1).optional(),
  pattern: z.string().min(1).optional(),
});

const assertVisibleStep = baseStep.extend({
  type: z.literal("assertVisible"),
  target: locatorSpecSchema,
});
const assertHiddenStep = baseStep.extend({
  type: z.literal("assertHidden"),
  target: locatorSpecSchema,
});
const assertTextStep = baseStep.extend({
  type: z.literal("assertText"),
  target: locatorSpecSchema,
  expected: z.string(),
});
const assertContainsTextStep = baseStep.extend({
  type: z.literal("assertContainsText"),
  target: locatorSpecSchema,
  expected: z.string(),
});
const assertValueStep = baseStep.extend({
  type: z.literal("assertValue"),
  target: locatorSpecSchema,
  expected: z.string(),
});
const assertURLStep = baseStep.extend({
  type: z.literal("assertURL"),
  expected: z.string().min(1).optional(),
  pattern: z.string().min(1).optional(),
});
const assertTitleStep = baseStep.extend({
  type: z.literal("assertTitle"),
  expected: z.string(),
});
const assertEnabledStep = baseStep.extend({
  type: z.literal("assertEnabled"),
  target: locatorSpecSchema,
});
const assertDisabledStep = baseStep.extend({
  type: z.literal("assertDisabled"),
  target: locatorSpecSchema,
});
const assertCheckedStep = baseStep.extend({
  type: z.literal("assertChecked"),
  target: locatorSpecSchema,
});

const screenshotStep = baseStep.extend({
  type: z.literal("screenshot"),
  name: z.string().min(1).optional(),
  fullPage: z.boolean().optional(),
});

// P1 — reusable-action invocation (P0 tooling rejects via unknown-type path
// until it learns P1; P1 compiler inlines the callee body explicitly).
const callActionStep = baseStep.extend({
  type: z.literal("callAction"),
  actionId: z.string().min(1),
  arguments: z.record(z.string()).optional(),
});

// ------------------------------------------------------- P1 wave 2 steps ---

const uploadStep = baseStep.extend({
  type: z.literal("upload"),
  target: locatorSpecSchema,
  fileId: z.string().min(1),
});
const downloadStep = baseStep.extend({
  type: z.literal("download"),
  target: locatorSpecSchema.optional(),
  url: z.string().min(1).optional(),
  saveAs: z.string().min(1).max(255).optional(),
});
const newTabStep = baseStep.extend({
  type: z.literal("newTab"),
  url: z.string().min(1).optional(),
});
const closeTabStep = baseStep.extend({ type: z.literal("closeTab") });
const handleDialogStep = baseStep.extend({
  type: z.literal("handleDialog"),
  action: z.enum(["accept", "dismiss"]),
  promptText: z.string().max(5000).optional(),
});
const apiRequestStep = baseStep.extend({
  type: z.literal("apiRequest"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string().min(1),
  headers: z.record(z.string()).optional(),
  body: z.string().max(200000).optional(),
  expectedStatus: z.number().int().min(100).max(599).optional(),
  saveAs: z.string().min(1).max(120).regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
});

export const testStepSchema = z.discriminatedUnion("type", [
  gotoStep,
  reloadStep,
  goBackStep,
  goForwardStep,
  clickStep,
  doubleClickStep,
  fillStep,
  clearStep,
  pressStep,
  checkStep,
  uncheckStep,
  selectStep,
  hoverStep,
  waitForElementStep,
  waitForTimeoutStep,
  waitForURLStep,
  assertVisibleStep,
  assertHiddenStep,
  assertTextStep,
  assertContainsTextStep,
  assertValueStep,
  assertURLStep,
  assertTitleStep,
  assertEnabledStep,
  assertDisabledStep,
  assertCheckedStep,
  screenshotStep,
  callActionStep,
  uploadStep,
  downloadStep,
  newTabStep,
  closeTabStep,
  handleDialogStep,
  apiRequestStep,
]).superRefine((val, ctx) => {
  // Cross-field rules live here (not on individual options) because
  // z.discriminatedUnion options must stay plain ZodObjects — .refine()
  // would wrap them in ZodEffects and break discriminator creation.
  if (val.type === "waitForURL" && val.url === undefined && val.pattern === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "waitForURL requires at least one of 'url' or 'pattern'",
    });
  }
  if (val.type === "assertURL" && val.expected === undefined && val.pattern === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "assertURL requires at least one of 'expected' or 'pattern'",
    });
  }
  if (val.type === "download" && val.target === undefined && val.url === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "download requires at least one of 'target' or 'url'",
    });
  }
});

// ------------------------------------------------------------ P1 actions ---

// P1 — reusable action body (project-scoped). Stored in `actions.definitionJson`.
export const actionParameterSchema = z.object({
  name: z.string().min(1).max(120).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  description: z.string().max(500).optional(),
  default: z.string().max(5000).optional(),
  secret: z.boolean().optional(),
});

export const reusableActionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  parameters: z.array(actionParameterSchema).max(50),
  steps: z.array(testStepSchema),
}).superRefine((val, ctx) => {
  // No nested callAction: inlining stays total and readable.
  if (val.steps.some((s) => s.type === "callAction")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "reusable action steps must be P0 steps (nested callAction rejected)",
    });
  }
  const names = val.parameters.map((p) => p.name);
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "parameter names must be unique" });
  }
});

// P1 — embedded data tables (CSV/JSON/table import lands here, capped).
const dataSetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  rows: z.array(z.record(z.string())).max(500),
});

// ------------------------------------------------------------- definition ---

export const testDefinitionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  browser: z.enum(["chromium", "firefox", "webkit"]),
  baseUrl: z.string().min(1).optional(),
  viewport: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .optional(),
  timeoutMs: z.number().int().positive().optional(),
  tags: z.array(z.string().min(1)).optional(),
  variables: z.record(z.string()).optional(),
  datasets: z.array(dataSetSchema).optional(),
  steps: z.array(testStepSchema),
});

export type TestDefinitionInput = z.input<typeof testDefinitionSchema>;
export type TestDefinitionOutput = z.output<typeof testDefinitionSchema>;

/** Validate without mutating the caller's object. Throws ZodError on failure. */
export function parseTestDefinition(input: unknown): TestDefinitionOutput {
  return testDefinitionSchema.parse(input);
}

/** Non-throwing variant. */
export function safeParseTestDefinition(input: unknown) {
  return testDefinitionSchema.safeParse(input);
}
