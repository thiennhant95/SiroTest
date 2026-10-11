/**
 * ai-provider.ts — server-side AI wiring for P2 routes (routes/ai.ts).
 *
 * - {@link getAIProvider} selects the LLM provider when `AI_API_KEY` is set
 *   (or `AI_PROVIDER=kilo` for the keyless Kilo free tier), otherwise the
 *   deterministic rule provider (never fakes AI).
 * - {@link loadProjectSecrets} + {@link redactForLLM} guarantee secret values
 *   and absolute server paths are stripped BEFORE any text is sent to an LLM.
 */
import { providerStatus, selectProvider, withLlmCache, type AIProvider } from '@vv/ai';
import { db } from './db.js';
import { decryptSecret, redactSecretsText, stripServerPaths } from './security.js';

/**
 * Module-level wrapper reuse (LLM cache by input hash). A fresh wrapper per
 * request would cache nothing, so wrappers live here keyed by the env
 * slice that selects them (key PRESENCE, never the secret value). Env
 * changes (tests, operator edits) naturally miss and rebuild.
 */
const wrapperCache = new Map<string, AIProvider>();

function wrapperCacheKey(slot: string): string {
  const e = process.env;
  return JSON.stringify({
    slot,
    provider: e.AI_PROVIDER ?? "",
    baseUrl: e.AI_BASE_URL ?? "",
    model: e.AI_MODEL ?? "",
    explainModel: e.AI_EXPLAIN_MODEL ?? "",
    hasKey: (e.AI_API_KEY ?? "") !== "",
    timeout: e.AI_TIMEOUT_MS ?? "",
    cache: e.AI_CACHE ?? "",
    cacheMax: e.AI_CACHE_MAX ?? "",
    cacheTtl: e.AI_CACHE_TTL_MS ?? "",
  });
}

function cachedProvider(slot: string, build: () => AIProvider): AIProvider {
  const key = wrapperCacheKey(slot);
  const hit = wrapperCache.get(key);
  if (hit) return hit;
  const fresh = withLlmCache(build());
  wrapperCache.set(key, fresh);
  // Distinct env combos are tiny in practice; cap paranoia at 25 slots.
  while (wrapperCache.size > 25) {
    const oldest = wrapperCache.keys().next();
    if (oldest.done) break;
    wrapperCache.delete(oldest.value);
  }
  return fresh;
}

export function getAIProvider(): AIProvider {
  return cachedProvider("default", () => selectProvider());
}

/**
 * Per-task routing: `AI_EXPLAIN_MODEL` overrides the model for failure
 * explanation ONLY (reasoning-heavy; interactive tasks stay on the cheap
 * `AI_MODEL` default). Same endpoint/key/timeout, just a different model —
 * and never an endpoint conjured from nothing (no LLM configured → rules).
 */
export function explainModelOverride(): string | undefined {
  const m = (process.env.AI_EXPLAIN_MODEL ?? "").trim();
  return m || undefined;
}

export function getExplainProvider(): AIProvider {
  const model = explainModelOverride();
  return cachedProvider("explain", () => selectProvider(process.env, model ? { model } : undefined));
}

/** Safe for GET /ai/status — engine/provider/model only, never the key. */
export function aiStatus(): { engine: 'rules' | 'llm'; provider: string; model?: string; explainModel?: string } {
  const status = providerStatus(getAIProvider());
  const explainModel = explainModelOverride();
  // Report the override only when it actually changes something (LLM active
  // and a different model than the default) — otherwise it is noise.
  if (status.engine === 'llm' && explainModel && explainModel !== status.model) {
    return { ...status, explainModel };
  }
  return status;
}

/**
 * Load plaintext secret values for a project (+ optional environment) so
 * failure text can be redacted before it reaches an LLM. Returns [] on any
 * error (redaction degrades to path-stripping, never throws the route).
 * The plaintext values never leave this module except into redactForLLM.
 */
export async function loadProjectSecrets(projectId: string, environmentId?: string): Promise<string[]> {
  try {
    const rows = await db().variable.findMany({
      where: {
        projectId,
        isSecret: true,
        ...(environmentId !== undefined ? { environmentId } : {}),
      },
      select: { valueEncrypted: true },
    });
    const out: string[] = [];
    for (const r of rows) {
      try {
        const plain = decryptSecret(r.valueEncrypted);
        if (plain) out.push(plain);
      } catch {
        /* undecryptable cell — skip, do not fail the route */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Redact secret values, then strip absolute server paths. */
export function redactForLLM(text: string, secrets: string[]): string {
  return stripServerPaths(redactSecretsText(text, secrets));
}
