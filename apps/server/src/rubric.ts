/**
 * rubric.ts — deterministic recording-quality score (0-100).
 *
 * A "stable" stamp says the definition passed N runs; the rubric says
 * whether the definition DESERVES confidence before spending those runs.
 * Pure function over the stored definition — no browser, no LLM, same
 * input always yields the same score.
 *
 * Checks (max 100):
 * - stable-primaries (30): role/label/testId/placeholder = 1, text/css = 0.5, xpath = 0
 * - alternatives      (15): fraction of locator steps carrying ≥1 alternative
 * - no-hard-waits     (15): 15 if zero waitForTimeout, else -5 each (floor 0)
 * - assertions        (20): ≥1 assertion step
 * - named-steps       (10): fraction with a non-empty name
 * - all-enabled       (10): fraction enabled
 */
export interface RubricCheck {
  id: string;
  label: string;
  earned: number;
  max: number;
  detail: string;
}

export interface RubricResult {
  score: number;
  maxScore: 100;
  checks: RubricCheck[];
}

const LOCATOR_STEPS = new Set([
  'click', 'doubleClick', 'fill', 'clear', 'press', 'check', 'uncheck',
  'select', 'hover', 'waitForElement', 'upload',
  'assertVisible', 'assertHidden', 'assertText', 'assertContainsText',
  'assertValue', 'assertEnabled', 'assertDisabled', 'assertChecked',
]);

const ASSERT_STEPS = new Set([
  'assertVisible', 'assertHidden', 'assertText', 'assertContainsText',
  'assertValue', 'assertURL', 'assertTitle',
  'assertEnabled', 'assertDisabled', 'assertChecked',
]);

const STABLE_STRATEGIES = new Set(['role', 'label', 'testId', 'placeholder']);

interface LooseStep {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  enabled?: unknown;
  target?: unknown;
}

function stepsOf(definition: unknown): LooseStep[] {
  const steps = (definition as { steps?: unknown })?.steps;
  if (!Array.isArray(steps)) return [];
  return steps.filter((s): s is LooseStep => typeof s === 'object' && s !== null);
}

function primaryOf(step: LooseStep): Record<string, unknown> | null {
  const target = step.target as { primary?: unknown } | null | undefined;
  if (!target || typeof target !== 'object') return null;
  const primary = (target as { primary?: unknown }).primary;
  return primary && typeof primary === 'object' ? (primary as Record<string, unknown>) : null;
}

function alternativesOf(step: LooseStep): unknown[] {
  const target = step.target as { alternatives?: unknown } | null | undefined;
  if (!target || typeof target !== 'object') return [];
  const alts = (target as { alternatives?: unknown }).alternatives;
  return Array.isArray(alts) ? alts : [];
}

export function scoreRubric(definition: unknown): RubricResult {
  const steps = stepsOf(definition);
  const checks: RubricCheck[] = [];
  if (steps.length === 0) {
    return {
      score: 0, maxScore: 100,
      checks: [{ id: 'has-steps', label: 'Has steps', earned: 0, max: 100, detail: 'no steps to score' }],
    };
  }

  const locatorSteps = steps.filter((s) => LOCATOR_STEPS.has(String(s.type)));
  let stableSum = 0;
  let withAlt = 0;
  for (const s of locatorSteps) {
    const primary = primaryOf(s);
    const strategy = typeof primary?.['strategy'] === 'string' ? (primary['strategy'] as string) : '';
    if (STABLE_STRATEGIES.has(strategy)) stableSum += 1;
    else if (strategy === 'text' || strategy === 'css') stableSum += 0.5;
    if (alternativesOf(s).length > 0) withAlt += 1;
  }
  const locatorNote = locatorSteps.length === 0 ? 'no locator-bearing steps' : `${locatorSteps.length} locator step(s)`;
  checks.push({
    id: 'stable-primaries', label: 'Stable primary locators', max: 30,
    earned: locatorSteps.length === 0 ? 30 : Math.round((stableSum / locatorSteps.length) * 30),
    detail: locatorSteps.length === 0 ? 'no locator-bearing steps (nothing flaky to match)' : `role/label/testId/placeholder preferred over text/css/xpath (${locatorNote})`,
  });
  checks.push({
    id: 'alternatives', label: 'Backup locators stored', max: 15,
    earned: locatorSteps.length === 0 ? 15 : Math.round((withAlt / locatorSteps.length) * 15),
    detail: locatorSteps.length === 0 ? 'nothing to heal' : `${withAlt}/${locatorSteps.length} locator steps carry alternatives (healing evidence)`,
  });

  const hardWaits = steps.filter((s) => s.type === 'waitForTimeout').length;
  checks.push({
    id: 'no-hard-waits', label: 'No hardcoded sleeps', max: 15,
    earned: Math.max(0, 15 - hardWaits * 5),
    detail: hardWaits === 0 ? 'no waitForTimeout steps' : `${hardWaits} waitForTimeout step(s) — prefer waitForElement`,
  });

  const assertions = steps.filter((s) => ASSERT_STEPS.has(String(s.type))).length;
  checks.push({
    id: 'assertions', label: 'Has assertions', max: 20,
    earned: assertions > 0 ? 20 : 0,
    detail: assertions === 0 ? 'no assertion step — the test cannot fail meaningfully' : `${assertions} assertion step(s)`,
  });

  const named = steps.filter((s) => typeof s.name === 'string' && s.name.trim().length > 0).length;
  checks.push({
    id: 'named-steps', label: 'Steps are named', max: 10,
    earned: Math.round((named / steps.length) * 10),
    detail: `${named}/${steps.length} steps carry human names (readable runs)`,
  });

  const enabled = steps.filter((s) => s.enabled !== false).length;
  checks.push({
    id: 'all-enabled', label: 'No disabled steps', max: 10,
    earned: Math.round((enabled / steps.length) * 10),
    detail: enabled === steps.length ? 'every step runs' : `${steps.length - enabled} disabled step(s) never execute`,
  });

  return { score: checks.reduce((a, c) => a + c.earned, 0), maxScore: 100, checks };
}
