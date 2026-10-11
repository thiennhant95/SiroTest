import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validateGeneratedSteps, type AIProvider } from '@vv/ai';
import { db } from '../db.js';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { requireProjectWrite } from '../rbac.js';
import { ApiError } from '../errors.js';
import { validateDefinitionForStore } from '../security.js';
import { getAIProvider, loadProjectSecrets, redactForLLM } from '../ai-provider.js';
import { recorderManager } from './recorder.js';

/**
 * P2 — suggested assertions from observed page (deterministic rules, NO AI
 * by default; opt-in `assist: true` appends LLM-proposed EXTRA assertions —
 * each schema-validated, engine-tagged `llm`, invalid ones dropped + counted).
 *
 * AI-generated assertions are a different P2 task; everything here is a
 * fixed rule over interaction steps the recorder/test already contains:
 *
 *   fill (+target, +value)      -> assertValue(same target, expected=value;
 *                                    sensitive values stay a {{VAR}} reference,
 *                                    flagged `masked: true`, never resolved)
 *   click/doubleClick (+target) -> assertVisible(next step's target when the
 *                                    next step has one, else the same target)
 *   check (+target)             -> assertChecked(same target)
 *   select (+target, +value)    -> assertValue(same target, expected=value)
 *   waitForElement (+target)    -> assertVisible(same target)
 *   goto (+url)                 -> assertURL(expected=url)
 *   waitForURL (+url|+pattern)  -> assertURL(expected=url ?? pattern)
 *   everything else             -> no suggestion (existing assertions, waits,
 *                                    navigation helpers and P1 steps carry no
 *                                    deterministic assertion)
 *
 * Suggestions are returned (never persisted) and inserted only via the
 * explicit apply endpoint, which versions the definition exactly like
 * PATCH /tests/:id. Unknown suggestion ids/indexes fail with
 * VALIDATION_ERROR — never silently skipped.
 *
 * WIRING (owner: server wiring — this file is new and NOT yet registered in
 * `apps/server/src/app.ts`, which is frozen for this task):
 *   `await v1.register(suggestionRoutes)` inside the `/api/v1` block of
 *   `buildApp()` in `app.ts` (one line, same as `testRoutes`).
 */

// ---------------------------------------------------------------------------
// Colocated zod schemas (route boundary shapes only)
// ---------------------------------------------------------------------------

const testIdParam = z.object({ id: z.string().min(1) });

const suggestionsBody = z.object({
  /** Live recorder session to mine (draft steps); falls back to definition. */
  sessionId: z.string().min(1).optional(),
  /** Explicit draft steps (recorded but not yet saved); wins over sessionId. */
  steps: z.array(z.record(z.unknown())).max(500).optional(),
  /** Opt-in LLM assist: propose EXTRA assertions beyond the rules (validated,
   *  engine-tagged, rules stay as fallback — never replaces them). */
  assist: z.boolean().optional(),
  // Intentionally NON-strict: the apply route re-parses its own body with
  // this schema to read an optional source override ({suggestionIds,
  // indexes, position} live alongside), so unknown keys must pass through.
});

const applyBody = z
  .object({
    suggestionIds: z.array(z.string().min(1)).max(200).optional(),
    indexes: z.array(z.number().int().nonnegative()).max(200).optional(),
    /** Default `after-source` inserts each step right after its source step. */
    position: z
      .union([z.literal('after-source'), z.object({ afterStepId: z.string().min(1) }), z.object({ atIndex: z.number().int().nonnegative() })])
      .optional(),
  }).strict()
  .refine((b) => (b.suggestionIds !== undefined) !== (b.indexes !== undefined), {
    message: 'Exactly one of suggestionIds / indexes is required',
  });

function parseOrThrowLocal<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ApiError('VALIDATION_ERROR', 'Invalid request payload', 400, r.error.flatten());
  }
  return r.data;
}

// ---------------------------------------------------------------------------
// Pure deterministic generator (exported for tests; no DB, no browser)
// ---------------------------------------------------------------------------

export interface SuggestedAssertion {
  /** Deterministic id: `sug:<sourceStepId>:<kind>:<n>`. */
  id: string;
  /** Source interaction step that motivated the suggestion. */
  stepId: string;
  /** Assertion step type to insert. */
  kind: string;
  /** Insert right after this step id (default position). */
  afterStepId: string;
  /** The assertion step to insert (id assigned on apply). */
  step: Record<string, unknown>;
  /** Human-readable rule explanation. */
  reason: string;
  /** Which engine produced this suggestion (rules always present; llm only with assist). */
  engine: 'rules' | 'llm';
  /** True when `expected` is a secret {{VAR}} reference (never resolved). */
  masked?: boolean;
}

type LooseStep = Record<string, unknown>;

function asTarget(step: LooseStep): Record<string, unknown> | null {
  const t = step['target'] as Record<string, unknown> | null | undefined;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  if (!t['primary'] || typeof t['primary'] !== 'object') return null;
  return t;
}

/**
 * Build suggestions for an ordered step list. Pure + deterministic: same
 * input steps always yield the same suggestion list (no AI, no browser).
 */
export function buildSuggestions(steps: LooseStep[]): SuggestedAssertion[] {
  const out: SuggestedAssertion[] = [];
  const perStepCount = new Map<string, number>();
  const idFor = (stepId: string, kind: string): string => {
    const n = (perStepCount.get(`${stepId}:${kind}`) ?? 0) + 1;
    perStepCount.set(`${stepId}:${kind}`, n);
    return `sug:${stepId}:${kind}:${n}`;
  };
  const list = Array.isArray(steps) ? steps : [];
  for (let i = 0; i < list.length; i++) {
    const step = list[i] as LooseStep;
    if (!step || typeof step !== 'object') continue;
    const stepId = typeof step['id'] === 'string' ? (step['id'] as string) : `step-${i}`;
    const type = typeof step['type'] === 'string' ? (step['type'] as string) : '';
    const target = asTarget(step);

    if (type === 'fill' && target && step['value'] !== undefined) {
      const sensitive = step['sensitive'] === true;
      out.push({
        id: idFor(stepId, 'assertValue'),
        stepId,
        kind: 'assertValue',
        engine: 'rules',
        afterStepId: stepId,
        step: { type: 'assertValue', enabled: true, target, expected: step['value'] },
        reason: sensitive
          ? `fill on a sensitive field — assert its value via the same {{VAR}} reference (masked, never resolved)`
          : `fill sets a known value — assert the field holds it`,
        ...(sensitive ? { masked: true } : {}),
      });
    } else if ((type === 'click' || type === 'doubleClick') && target) {
      const next = list[i + 1] as LooseStep | undefined;
      const nextTarget = next && typeof next === 'object' ? asTarget(next) : null;
      if (nextTarget) {
        const nextId = typeof next!['id'] === 'string' ? (next!['id'] as string) : `step-${i + 1}`;
        out.push({
          id: idFor(stepId, 'assertVisible'),
          stepId,
          kind: 'assertVisible',
          engine: 'rules',
        afterStepId: stepId,
          step: { type: 'assertVisible', enabled: true, target: nextTarget },
          reason: `click leads to the next step's target — assert it became visible`,
        });
        void nextId;
      } else {
        out.push({
          id: idFor(stepId, 'assertVisible'),
          stepId,
          kind: 'assertVisible',
          engine: 'rules',
        afterStepId: stepId,
          step: { type: 'assertVisible', enabled: true, target },
          reason: `click has no following target — assert the clicked element is still visible (weak fallback)`,
        });
      }
    } else if (type === 'check' && target) {
      out.push({
        id: idFor(stepId, 'assertChecked'),
        stepId,
        kind: 'assertChecked',
        engine: 'rules',
        afterStepId: stepId,
        step: { type: 'assertChecked', enabled: true, target },
        reason: `check sets checked state — assert it`,
      });
    } else if (type === 'select' && target && step['value'] !== undefined) {
      out.push({
        id: idFor(stepId, 'assertValue'),
        stepId,
        kind: 'assertValue',
        engine: 'rules',
        afterStepId: stepId,
        step: { type: 'assertValue', enabled: true, target, expected: step['value'] },
        reason: `select sets a known option — assert the field holds it`,
      });
    } else if (type === 'waitForElement' && target) {
      out.push({
        id: idFor(stepId, 'assertVisible'),
        stepId,
        kind: 'assertVisible',
        engine: 'rules',
        afterStepId: stepId,
        step: { type: 'assertVisible', enabled: true, target },
        reason: `waitForElement already waits for the target — pin it with an assertion`,
      });
    } else if (type === 'goto' && typeof step['url'] === 'string' && (step['url'] as string).length > 0) {
      out.push({
        id: idFor(stepId, 'assertURL'),
        stepId,
        kind: 'assertURL',
        engine: 'rules',
        afterStepId: stepId,
        step: { type: 'assertURL', enabled: true, expected: step['url'] },
        reason: `goto navigates to a known URL — assert it`,
      });
    } else if (type === 'waitForURL') {
      const expected = typeof step['url'] === 'string' && (step['url'] as string).length > 0
        ? step['url']
        : typeof step['pattern'] === 'string' && (step['pattern'] as string).length > 0
          ? step['pattern']
          : undefined;
      if (expected !== undefined) {
        out.push({
          id: idFor(stepId, 'assertURL'),
          stepId,
          kind: 'assertURL',
          engine: 'rules',
        afterStepId: stepId,
          step: { type: 'assertURL', enabled: true, expected },
          reason: `waitForURL already waits for the URL — pin it with an assertion`,
        });
      }
    }
  }
  return out;
}

/** Source steps for suggestions: explicit param > recorder session > stored definition. */
function resolveSourceSteps(
  test: { id: string; definitionJson: string },
  body: { sessionId?: string; steps?: Array<Record<string, unknown>> },
  userId: string,
): { steps: LooseStep[]; source: 'steps-param' | 'recorder-session' | 'definition' } {
  if (body.steps !== undefined) {
    for (const s of body.steps) {
      if (!s || typeof s !== 'object' || typeof (s as LooseStep)['type'] !== 'string') {
        throw new ApiError('VALIDATION_ERROR', 'Each provided step must be an object with a string type', 400);
      }
    }
    return { steps: body.steps as LooseStep[], source: 'steps-param' };
  }
  if (body.sessionId !== undefined) {
    const session = recorderManager.getBySessionId(body.sessionId);
    if (!session) throw new ApiError('NOT_FOUND', `Recorder session ${body.sessionId} not found`, 404);
    if (session.userId !== userId) {
      throw new ApiError('FORBIDDEN', 'Recorder session belongs to another user', 403);
    }
    const draft = (session.draftSteps ?? []) as Array<{
      id: string;
      type: string;
      locator?: unknown;
      value?: string;
      key?: string;
      url: string;
    }>;
    return {
      steps: draft.map((s) => ({
        id: s.id,
        type: s.type,
        enabled: true,
        target: s.locator ?? null,
        ...(s.value !== undefined ? { value: s.value } : {}),
        ...(s.key !== undefined ? { key: s.key } : {}),
        ...(s.url ? { url: s.url } : {}),
      })),
      source: 'recorder-session',
    };
  }
  const def = JSON.parse(test.definitionJson) as { steps?: unknown };
  return { steps: (Array.isArray(def.steps) ? def.steps : []) as LooseStep[], source: 'definition' };
}

function assertStorableSteps(steps: unknown): void {
  const issues = validateDefinitionForStore({ steps });
  if (issues.length > 0) {
    const unsupported = issues.some((i) => i.code === 'STEP_TYPE_UNSUPPORTED' || i.code === 'STEP_FIELD_FORBIDDEN');
    throw new ApiError(
      unsupported ? 'COMPILER_UNSUPPORTED_STEP' : 'VALIDATION_ERROR',
      `Invalid test definition: ${issues.map((i) => i.message).join('; ')}`,
      unsupported ? 422 : 400,
      { issues },
    );
  }
}

// ---------------------------------------------------------------------------
// Opt-in LLM assist (P2 backlog): EXTRA assertion proposals beyond the rules
// ---------------------------------------------------------------------------

export interface AssistResult {
  engine: 'rules' | 'llm';
  added: number;
  dropped: number;
  note: string;
}

function stripFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

const ASSERTION_KINDS: ReadonlySet<string> = new Set([
  'assertVisible', 'assertHidden', 'assertText', 'assertContainsText',
  'assertValue', 'assertURL', 'assertTitle', 'assertEnabled',
  'assertDisabled', 'assertChecked', 'screenshot',
]);

function summarizeStep(step: LooseStep, index: number): string {
  const id = typeof step['id'] === 'string' ? (step['id'] as string) : `step-${index}`;
  const type = typeof step['type'] === 'string' ? (step['type'] as string) : '?';
  const t = step['target'] as { primary?: Record<string, unknown> } | undefined;
  const primary = t?.primary && typeof t.primary === 'object' ? t.primary : null;
  // Values stay OUT of the prompt (fill values may be secret-adjacent);
  // the model proposes targets/assertions, the server re-attaches nothing.
  const where = primary
    ? Object.entries(primary)
      .filter(([k]) => k !== 'value')
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v)}`)
      .join(',')
    : 'no-target';
  return `${id}: ${type} [${where}]`;
}

/**
 * Ask the LLM for EXTRA assertions (rules output is untouched — extras are
 * appended, engine-tagged `llm`). Every candidate must survive canonical
 * schema validation + the store allowlist + reference a real step id;
 * anything else is dropped and COUNTED in the note (never silent).
 * No LLM configured (or any failure) → rules-only with an explicit note.
 */
export async function llmAssistSuggestions(
  steps: LooseStep[],
  projectId: string,
  deps: { provider?: AIProvider; secrets?: string[] } = {},
): Promise<{ extra: SuggestedAssertion[]; result: AssistResult }> {
  const none = (note: string): { extra: SuggestedAssertion[]; result: AssistResult } => ({
    extra: [],
    result: { engine: 'rules', added: 0, dropped: 0, note },
  });
  const provider = deps.provider ?? getAIProvider();
  if (provider.engine !== 'llm') {
    return none('LLM assist requested but no LLM is configured — rules only (set AI_API_KEY or AI_PROVIDER)');
  }
  const stepIds = new Set<string>();
  steps.forEach((s, i) => stepIds.add(typeof (s as LooseStep)['id'] === 'string' ? ((s as LooseStep)['id'] as string) : `step-${i}`));
  const secrets = deps.secrets ?? await loadProjectSecrets(projectId).catch(() => [] as string[]);
  const prompt = redactForLLM(
    [
      'This test has these steps (id: type [locator]). Propose EXTRA Playwright assertions',
      'that the deterministic rules would miss (e.g. assertHidden after navigation,',
      'assertTitle after goto, assertContainsText for dynamic content). Respond with a',
      'single JSON object: {"assertions": [{"kind": "<assertKind>", "afterStepId": "<id>",',
      '"target": <LocatorSpec|null>, "expected": "<string|null>"}]}.',
      'Reference ONLY the step ids above; propose at most 5. Empty array when nothing is missing.',
      '',
      ...steps.map((s, i) => summarizeStep(s as LooseStep, i)),
    ].join('\n'),
    secrets,
  ).slice(0, 12000);
  let raw: string;
  try {
    raw = await provider.complete(prompt, { jsonMode: true, maxTokens: 1500 });
  } catch (err) {
    return none(`LLM assist failed (${(err as Error).message}) — rules only`);
  }
  let candidates: unknown[];
  try {
    const parsed = JSON.parse(stripFences(raw)) as { assertions?: unknown };
    candidates = Array.isArray(parsed.assertions) ? parsed.assertions : [];
  } catch {
    return none('LLM assist returned unparseable JSON — rules only');
  }
  const extra: SuggestedAssertion[] = [];
  let dropped = 0;
  const perKindCount = new Map<string, number>();
  for (const c of candidates.slice(0, 5)) {
    const cand = (c ?? {}) as Record<string, unknown>;
    if (typeof cand['kind'] !== 'string' || !ASSERTION_KINDS.has(cand['kind'] as string)) { dropped += 1; continue; }
    if (typeof cand['afterStepId'] !== 'string' || !stepIds.has(cand['afterStepId'] as string)) { dropped += 1; continue; }
    const stepPayload: Record<string, unknown> = {
      type: cand['kind'],
      enabled: true,
      ...(cand['target'] !== undefined && cand['target'] !== null ? { target: cand['target'] } : {}),
      ...(typeof cand['expected'] === 'string' ? { expected: (cand['expected'] as string).slice(0, 500) } : {}),
    };
    const { valid, invalidCount } = validateGeneratedSteps([{ id: 'assist_tmp', ...stepPayload }]);
    if (invalidCount > 0 || valid.length === 0) { dropped += 1; continue; }
    if (validateDefinitionForStore({ steps: [valid[0]] }).length > 0) { dropped += 1; continue; }
    const kind = cand['kind'] as string;
    const afterStepId = cand['afterStepId'] as string;
    const n = (perKindCount.get(`${afterStepId}:${kind}`) ?? 0) + 1;
    perKindCount.set(`${afterStepId}:${kind}`, n);
    extra.push({
      id: `sug:llm:${afterStepId}:${kind}:${n}`,
      stepId: afterStepId,
      kind,
      engine: 'llm',
      afterStepId,
      step: { ...(valid[0] as unknown as Record<string, unknown>), id: undefined },
      reason: `LLM-proposed extra assertion after ${afterStepId} (schema-validated; review before applying)`,
    });
    // `id: undefined` drops the temp id in JSON — the apply route mints a fresh one.
  }
  return {
    extra,
    result: {
      engine: 'llm',
      added: extra.length,
      dropped,
      note: dropped > 0
        ? `LLM proposed ${extra.length + dropped}; ${dropped} failed validation and were dropped`
        : `LLM proposed ${extra.length} extra assertion(s)`,
    },
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function suggestionRoutes(app: FastifyInstance): Promise<void> {
  // Generate deterministic assertion suggestions (nothing is persisted).
  app.post('/tests/:id/suggestions', { preHandler: requireAuth }, async (req) => {
    const { id } = parseOrThrowLocal(testIdParam, req.params);
    await requireProjectAccess(req);
    const test = await db().test.findUnique({ where: { id } });
    if (!test) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    const body = parseOrThrowLocal(suggestionsBody, req.body ?? {});
    const { steps, source } = resolveSourceSteps(test, body, req.user!.id);
    const rules = buildSuggestions(steps);
    if (body.assist !== true) {
      return { testId: id, source, stepCount: steps.length, suggestions: rules };
    }
    const { extra, result: assist } = await llmAssistSuggestions(steps, test.projectId);
    return { testId: id, source, stepCount: steps.length, suggestions: [...rules, ...extra], assist };
  });

  // Apply selected suggestions: insert assertion steps + mint a new version.
  app.post('/tests/:id/suggestions/apply', { preHandler: requireAuth }, async (req) => {
    const { id } = parseOrThrowLocal(testIdParam, req.params);
    await requireProjectWrite(req);
    const body = parseOrThrowLocal(applyBody, req.body ?? {});
    const test = await db().test.findUnique({
      where: { id },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });
    if (!test) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    const genBody = parseOrThrowLocal(suggestionsBody, (req.body as Record<string, unknown> | undefined) ?? {});
    const { steps: sourceSteps } = resolveSourceSteps(test, { sessionId: genBody.sessionId, steps: genBody.steps }, req.user!.id);
    const generated = buildSuggestions(sourceSteps);
    const byId = new Map(generated.map((s) => [s.id, s]));

    let selected: SuggestedAssertion[];
    if (body.suggestionIds !== undefined) {
      const unknown = body.suggestionIds.filter((sid) => !byId.has(sid));
      if (unknown.length > 0) {
        throw new ApiError('VALIDATION_ERROR', `Unknown suggestion ids: ${unknown.join(', ')}`, 400, { unknown });
      }
      selected = body.suggestionIds.map((sid) => byId.get(sid)!);
    } else {
      const outOfRange = (body.indexes ?? []).filter((n) => n >= generated.length);
      if (outOfRange.length > 0) {
        throw new ApiError(
          'VALIDATION_ERROR',
          `Suggestion indexes out of range (0..${generated.length - 1}): ${outOfRange.join(', ')}`,
          400,
          { outOfRange },
        );
      }
      selected = (body.indexes ?? []).map((n) => generated[n]!);
    }
    if (selected.length === 0) {
      throw new ApiError('VALIDATION_ERROR', 'No suggestions selected', 400);
    }

    const def = JSON.parse(test.definitionJson) as { steps?: Array<Record<string, unknown>> };
    const existing = Array.isArray(def.steps) ? [...def.steps] : [];
    const takenIds = new Set(existing.map((s) => String((s as Record<string, unknown>)['id'])));
    const freshId = (base: string): string => {
      let candidate = base;
      let n = 2;
      while (takenIds.has(candidate)) {
        candidate = `${base}-${n}`;
        n += 1;
      }
      takenIds.add(candidate);
      return candidate;
    };
    const toInsert = selected.map((s) => ({
      suggestionId: s.id,
      afterStepId: s.afterStepId,
      step: { id: freshId(`${s.stepId}-assert-${s.kind}`), ...s.step },
    }));

    const position = body.position ?? 'after-source';
    let next: Array<Record<string, unknown>>;
    if (position === 'after-source') {
      const insertAfter = new Map<string, Array<Record<string, unknown>>>();
      for (const item of toInsert) {
        const bucket = insertAfter.get(item.afterStepId) ?? [];
        bucket.push(item.step as Record<string, unknown>);
        insertAfter.set(item.afterStepId, bucket);
      }
      next = [];
      for (const s of existing) {
        next.push(s as Record<string, unknown>);
        const bucket = insertAfter.get(String((s as Record<string, unknown>)['id']));
        if (bucket) next.push(...bucket);
      }
      // Source steps from a param/session may not exist in the definition
      // (apply-onto-other-source is a client error, never a silent drop).
      const missing = [...insertAfter.keys()].filter(
        (sid) => !existing.some((s) => String((s as Record<string, unknown>)['id']) === sid),
      );
      if (missing.length > 0) {
        throw new ApiError(
          'VALIDATION_ERROR',
          `Source step(s) not in the stored definition: ${missing.join(', ')} — regenerate suggestions from the definition first`,
          400,
          { missing },
        );
      }
    } else if (typeof position === 'object' && 'afterStepId' in position) {
      const anchor = (position as { afterStepId: string }).afterStepId;
      const anchorIdx = existing.findIndex((s) => String((s as Record<string, unknown>)['id']) === anchor);
      if (anchorIdx === -1) {
        throw new ApiError('VALIDATION_ERROR', `position.afterStepId '${anchor}' is not a step of this test`, 400);
      }
      next = [...existing];
      next.splice(anchorIdx + 1, 0, ...(toInsert.map((i) => i.step) as Array<Record<string, unknown>>));
    } else {
      const atIndex = (position as { atIndex: number }).atIndex;
      if (atIndex > existing.length) {
        throw new ApiError('VALIDATION_ERROR', `position.atIndex ${atIndex} exceeds step count ${existing.length}`, 400);
      }
      next = [...existing];
      next.splice(atIndex, 0, ...(toInsert.map((i) => i.step) as Array<Record<string, unknown>>));
    }

    assertStorableSteps(next);
    const nextJson = JSON.stringify({ ...def, steps: next });
    const updated = await db().test.update({
      where: { id },
      // Inserted steps: void the stability stamp (PATCH rule).
      data: { definitionJson: nextJson, stable: false, stableAt: null, stableRuns: 0 },
    });
    const nextVersion = (test.versions[0]?.versionNumber ?? 0) + 1;
    const version = await db().testVersion.create({
      data: {
        testId: id,
        versionNumber: nextVersion,
        definitionJson: nextJson,
        createdBy: req.user!.id,
        changeMessage: `suggestions: inserted ${toInsert.length} assertion step(s) by ${req.user!.id}`,
      },
    });
    return {
      testId: id,
      versionNumber: version.versionNumber,
      stepCount: next.length,
      applied: toInsert.map((i) => ({ suggestionId: i.suggestionId, stepId: String((i.step as Record<string, unknown>)['id']), afterStepId: i.afterStepId })),
      test: updated,
    };
  });
}
