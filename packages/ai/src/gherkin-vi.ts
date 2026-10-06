/**
 * gherkin-vi.ts — deterministic Vietnamese Gherkin subset → P0/P1 steps.
 *
 * Testers write `Cho rằng / Khi / Thì` and this rules engine (no LLM)
 * parses it into step candidates. Clauses the matchers do not understand
 * are returned in `unparsed[]` EXPLICITLY — never invented into steps.
 *
 * Every emitted step passes `testStepSchema.safeParse`; anything failing
 * the schema lands in `unparsed` instead of leaking invalid shapes.
 *
 * Subset rules (see docs/gherkin-vi-plan.md):
 *  - Keywords are case-insensitive, trailing `:` on headers is optional.
 *  - `Và`/`Nhưng` inherit the current Given/When/Then section of the same
 *    block; with no section they are unparsed.
 *  - `Bối cảnh:` (Background) steps are prepended to the parsed scenario.
 *  - Only the FIRST scenario is parsed; later ones go to `warnings[]`.
 *  - `Ví dụ:`/`Examples:` and `| table |` rows are unparsed, never fatal.
 *  - Lines starting with `#` are comments (skipped).
 *  - Step ids are `g1`, `g2`, … (own counter, resettable for tests).
 */
import { testStepSchema } from "@playwright-studio/test-model";
import { parseNlClause } from "./nl-to-steps.js";
import type { LooseStep } from "./nl-to-steps.js";

export interface GherkinViResult {
  steps: LooseStep[];
  /** Lines the rules did not understand — caller must show these (`Dòng <n>: <text>`). */
  unparsed: string[];
  /** Non-fatal notes, e.g. skipped later scenarios. */
  warnings: string[];
  scenarioName?: string;
  tags: string[];
}

let gCounter = 0;

/** Resettable for deterministic tests. */
export function resetGherkinStepCounter(): void {
  gCounter = 0;
}

function nextGId(): string {
  gCounter += 1;
  return `g${gCounter}`;
}

const FEATURE_KEYS = ["tính năng", "chức năng", "feature"];
const BACKGROUND_KEYS = ["bối cảnh", "background"];
const SCENARIO_KEYS = ["kịch bản", "tình huống", "scenario", "example"];
const EXAMPLES_KEYS = ["ví dụ", "examples"];
const GIVEN_KEYS = ["cho rằng", "giả sử", "với", "given"];
const WHEN_KEYS = ["khi", "when"];
const THEN_KEYS = ["thì", "vậy thì", "then"];
const AND_KEYS = ["và", "and"];
const BUT_KEYS = ["nhưng", "but"];

type Section = "given" | "when" | "then";

/**
 * Match a leading keyword (case-insensitive, optional trailing colon).
 * Returns the remainder after the keyword, or null when nothing matches.
 */
function splitKeyword(trimmed: string, keywords: string[]): string | null {
  const low = trimmed.toLowerCase();
  const ordered = [...keywords].sort((a, b) => b.length - a.length);
  for (const kw of ordered) {
    if (low === kw) return "";
    if (low.startsWith(`${kw}:`) || low.startsWith(`${kw} `) || low.startsWith(`${kw}\t`)) {
      return trimmed.slice(kw.length).replace(/^:\s*/, "").trim();
    }
  }
  return null;
}

interface PendingClause {
  clause: string;
  lineNo: number;
  raw: string;
}

/**
 * Parse Vietnamese Gherkin text into P0/P1 steps. Pure + deterministic
 * except for the `g<n>` id counter (see resetGherkinStepCounter).
 */
export function gherkinViToSteps(text: string): GherkinViResult {
  const steps: LooseStep[] = [];
  const unparsed: string[] = [];
  const warnings: string[] = [];
  const tags: string[] = [];
  let scenarioName: string | undefined;

  const backgroundClauses: PendingClause[] = [];
  const scenarioClauses: PendingClause[] = [];

  let scenarioCount = 0;
  let inBackground = false;
  let inFirstScenario = false;
  let skippingLater = false;
  let section: Section | null = null;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const raw = lines[i]!.trim();
    if (!raw) continue;
    if (raw.startsWith("#")) continue;

    let content = raw;
    if (content.startsWith("@")) {
      const tagRe = /@[^\s@]+/g;
      let m: RegExpExecArray | null;
      while ((m = tagRe.exec(content)) !== null) {
        const name = m[0]!.slice(1).replace(/[.,;:!?]+$/, "");
        if (name) tags.push(name);
      }
      content = content.replace(/@[^\s@]+/g, "").trim().replace(/^[,;\s]+/, "");
      if (!content) continue;
    }

    if (content.startsWith("|")) {
      unparsed.push(`Dòng ${lineNo}: ${raw}`);
      continue;
    }

    if (splitKeyword(content, EXAMPLES_KEYS) !== null) {
      unparsed.push(`Dòng ${lineNo}: ${raw}`);
      continue;
    }
    if (splitKeyword(content, FEATURE_KEYS) !== null) {
      inBackground = false;
      inFirstScenario = false;
      skippingLater = false;
      section = null;
      continue;
    }
    if (splitKeyword(content, BACKGROUND_KEYS) !== null) {
      inBackground = true;
      inFirstScenario = false;
      skippingLater = false;
      section = null;
      continue;
    }
    const scenarioRest = splitKeyword(content, SCENARIO_KEYS);
    if (scenarioRest !== null) {
      scenarioCount += 1;
      section = null;
      if (scenarioCount === 1) {
        inBackground = false;
        inFirstScenario = true;
        skippingLater = false;
        if (scenarioRest) scenarioName = scenarioRest;
      } else {
        inBackground = false;
        inFirstScenario = false;
        skippingLater = true;
        warnings.push(
          `Dòng ${lineNo}: bỏ qua kịch bản thứ ${scenarioCount}` +
            (scenarioRest ? ` "${scenarioRest}"` : "") +
            ` — chỉ phân tích kịch bản đầu tiên`,
        );
      }
      continue;
    }
    // Later scenarios are neither parsed nor lost (covered by warnings).
    if (skippingLater) continue;

    const target = inBackground
      ? backgroundClauses
      : inFirstScenario
        ? scenarioClauses
        : null;

    let clause: string | null = null;
    const givenRest = splitKeyword(content, GIVEN_KEYS);
    const whenRest = givenRest === null ? splitKeyword(content, WHEN_KEYS) : null;
    const thenRest = givenRest === null && whenRest === null ? splitKeyword(content, THEN_KEYS) : null;
    if (givenRest !== null) {
      clause = givenRest;
      section = "given";
    } else if (whenRest !== null) {
      clause = whenRest;
      section = "when";
    } else if (thenRest !== null) {
      clause = thenRest;
      section = "then";
    } else {
      const andRest = splitKeyword(content, AND_KEYS);
      const butRest = andRest === null ? splitKeyword(content, BUT_KEYS) : null;
      const inherited = andRest ?? butRest;
      if (inherited !== null) {
        if (section === null) {
          unparsed.push(`Dòng ${lineNo}: ${raw}`);
          continue;
        }
        clause = inherited;
      }
    }
    if (clause === null || clause === "") {
      // Unknown line or keyword without a clause — explicit, never fatal.
      unparsed.push(`Dòng ${lineNo}: ${raw}`);
      continue;
    }
    if (target === null) {
      // Step outside Bối cảnh/Kịch bản.
      unparsed.push(`Dòng ${lineNo}: ${raw}`);
      continue;
    }
    target.push({ clause, lineNo, raw });
  }

  // Background first, then the first scenario — ids stay sequential.
  for (const pending of [...backgroundClauses, ...scenarioClauses]) {
    const candidate = parseNlClause(pending.clause);
    if (!candidate) {
      unparsed.push(`Dòng ${pending.lineNo}: ${pending.raw}`);
      continue;
    }
    candidate.id = nextGId();
    if (testStepSchema.safeParse(candidate).success) {
      steps.push(candidate);
    } else {
      unparsed.push(`Dòng ${pending.lineNo}: ${pending.raw}`);
    }
  }

  const result: GherkinViResult = { steps, unparsed, warnings, tags };
  if (scenarioName !== undefined) result.scenarioName = scenarioName;
  return result;
}
