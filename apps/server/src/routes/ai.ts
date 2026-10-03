/**
 * P2 AI routes (preview-only, never persist, never fake AI).
 *
 * Wiring contract (apps/server/src/app.ts is intentionally untouched here):
 *   import { aiRoutes } from './routes/ai.js';
 *   await v1.register(aiRoutes);   // inside the /api/v1 block
 *
 * Endpoints (all requireAuth; preview only — no write to tests/runs):
 *   GET  /ai/status      → { engine, provider, model? } (never leaks the key)
 *   POST /ai/nl-to-steps → { engine, steps, unparsed[] }
 *   POST /ai/explain     → { engine, explanation }
 *   POST /ai/cleanup     → { engine, steps, changes[] } (sorted definition is
 *                          NOT written back — caller PATCHes /tests/:id itself)
 *
 * Engine honesty: without `AI_API_KEY` every endpoint answers with
 * `engine: 'rules'` (deterministic @vv/ai rule engines). With a key,
 * nl-to-steps and explain attempt the LLM and fall back to rules on any
 * failure (parse error, timeout, HTTP error) — the reported `engine` always
 * reflects the path that actually produced the payload.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  cleanupRecording,
  explainFailure,
  nlToSteps,
  nlToStepsSystemPrompt,
  validateGeneratedSteps,
} from '@vv/ai';
import { requireAuth } from '../auth.js';
import { ApiError } from '../errors.js';
import { parseOrThrow } from '../schemas.js';
import { db } from '../db.js';
import { aiStatus, getAIProvider, loadProjectSecrets, redactForLLM } from '../ai-provider.js';

// ------------------------------------------------------------- zod (colocated) ---

const nlBody = z.object({
  text: z.string().min(1).max(8000),
  /** Accepted for future project scoping; unused by the stateless rule path. */
  projectId: z.string().min(1).optional(),
});

const explainBody = z.object({
  runId: z.string().min(1).optional(),
  stepId: z.string().min(1).optional(),
  errorSummary: z.string().max(20000).optional(),
  stepType: z.string().max(80).optional(),
  stepName: z.string().max(300).optional(),
  locator: z.record(z.unknown()).optional(),
  timeoutMs: z.number().int().positive().max(600000).optional(),
  projectId: z.string().min(1).optional(),
  environmentId: z.string().min(1).optional(),
});

const cleanupBody = z.object({
  testId: z.string().min(1).optional(),
  steps: z.array(z.record(z.unknown())).max(500).optional(),
});

// ------------------------------------------------------------------ helpers ---

function stripFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

interface LlmNlPayload {
  steps?: unknown;
  unparsed?: unknown;
}

/** LLM attempt for nl-to-steps; throws on any failure (caller falls back). */
async function nlViaLlm(text: string): Promise<{ steps: unknown[]; unparsed: string[] }> {
  const provider = getAIProvider();
  if (provider.engine !== 'llm') throw new Error('LLM provider not configured');
  const raw = await provider.complete(`Convert this test instruction into steps:\n${text}`, {
    systemPrompt: nlToStepsSystemPrompt(),
    jsonMode: true,
    maxTokens: 2000,
  });
  const parsed = JSON.parse(stripFences(raw)) as LlmNlPayload | unknown[];
  const candidates = Array.isArray(parsed) ? parsed : (parsed as LlmNlPayload).steps;
  if (!Array.isArray(candidates)) throw new Error('LLM reply had no steps array');
  const { valid, invalidCount } = validateGeneratedSteps(candidates);
  const unparsedRaw = !Array.isArray(parsed) && Array.isArray((parsed as LlmNlPayload).unparsed)
    ? ((parsed as LlmNlPayload).unparsed as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  const unparsed = [...unparsedRaw];
  if (invalidCount > 0) {
    unparsed.push(`(${invalidCount} LLM-proposed step(s) failed schema validation and were dropped)`);
  }
  return { steps: valid, unparsed };
}

// ------------------------------------------------------------------- routes ---

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ai/status', { preHandler: requireAuth }, async () => aiStatus());

  app.post('/ai/nl-to-steps', { preHandler: requireAuth }, async (req) => {
    const body = parseOrThrow(nlBody, req.body);
    // Honest LLM attempt first; any failure → deterministic rules.
    try {
      const llm = await nlViaLlm(body.text);
      return { engine: 'llm' as const, steps: llm.steps, unparsed: llm.unparsed };
    } catch {
      const rules = nlToSteps(body.text);
      return { engine: 'rules' as const, steps: rules.steps, unparsed: rules.unparsed };
    }
  });

  app.post('/ai/explain', { preHandler: requireAuth }, async (req) => {
    const body = parseOrThrow(explainBody, req.body);
    let errorSummary = body.errorSummary;
    let stepType = body.stepType;
    let stepName = body.stepName;
    let locator = body.locator as unknown;
    let timeoutMs = body.timeoutMs;
    let secrets: string[] = [];

    if (body.runId !== undefined) {
      const run = await db().run.findUnique({ where: { id: body.runId }, include: { steps: true } });
      if (!run) throw new ApiError('NOT_FOUND', `Run ${body.runId} not found`, 404);
      const failed = run.steps.find((s) => body.stepId !== undefined ? s.stepId === body.stepId : s.status === 'failed')
        ?? run.steps.find((s) => s.errorMessage);
      errorSummary = body.errorSummary
        ?? failed?.errorMessage
        ?? run.errorSummary
        ?? undefined;
      if (!errorSummary) {
        throw new ApiError('VALIDATION_ERROR', 'Run has no failure to explain (no failed step, no errorSummary)', 400);
      }
      // Step type/name are not stored on RunStep; leave caller overrides intact.
      const projectSecrets = await loadProjectSecrets(run.projectId, run.environmentId ?? undefined);
      const extraSecrets = body.projectId
        ? await loadProjectSecrets(body.projectId, body.environmentId)
        : [];
      secrets = [...projectSecrets, ...extraSecrets];
    } else {
      if (!errorSummary) {
        throw new ApiError('VALIDATION_ERROR', 'Either runId or errorSummary is required', 400);
      }
      if (body.projectId) secrets = await loadProjectSecrets(body.projectId, body.environmentId);
    }

    const redacted = redactForLLM(errorSummary!, secrets).slice(0, 20000);
    const { engine, explanation } = await explainFailure(
      {
        errorSummary: redacted,
        ...(stepType !== undefined ? { stepType } : {}),
        ...(stepName !== undefined ? { stepName } : {}),
        ...(locator !== undefined ? { locator } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
      getAIProvider(),
    );
    return { engine, explanation };
  });

  app.post('/ai/cleanup', { preHandler: requireAuth }, async (req) => {
    const body = parseOrThrow(cleanupBody, req.body);
    let rawSteps: Array<Record<string, unknown>>;
    if (body.testId !== undefined) {
      const test = await db().test.findUnique({ where: { id: body.testId } });
      if (!test) throw new ApiError('NOT_FOUND', `Test ${body.testId} not found`, 404);
      let def: unknown;
      try {
        def = JSON.parse(test.definitionJson) as unknown;
      } catch {
        throw new ApiError('VALIDATION_ERROR', 'Stored definitionJson is not valid JSON', 400);
      }
      const steps = (def as { steps?: unknown }).steps;
      if (!Array.isArray(steps)) {
        throw new ApiError('VALIDATION_ERROR', 'Stored definition has no steps array', 400);
      }
      rawSteps = steps as Array<Record<string, unknown>>;
    } else if (body.steps !== undefined) {
      rawSteps = body.steps;
    } else {
      throw new ApiError('VALIDATION_ERROR', 'Either testId or steps is required', 400);
    }
    // Always rule-based + deterministic; preview only (never persisted here).
    const { steps, changes } = cleanupRecording(rawSteps);
    return { engine: 'rules' as const, steps, changes };
  });
}
