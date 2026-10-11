/**
 * provider.ts — P2 AI provider boundary.
 *
 * Honesty contract (P2 backlog): there is NO fake AI in this repo.
 * - When `AI_API_KEY` is set, {@link EnvProvider} calls an OpenAI-compatible
 *   chat-completions endpoint and `engine` is reported as `'llm'`.
 * - When `AI_PROVIDER=kilo|uncloseai`, {@link EnvProvider} calls a keyless
 *   free tier (Kilo gateway `kilo-auto/free` default, uncloseai Qwen default)
 *   with NO key (anonymous, rate-limited). `engine` is `'llm'`.
 * - Otherwise {@link selectProvider} returns the always available
 *   {@link RuleProvider} and `engine` is reported as `'rules'`
 *   (deterministic, local, rule-based — never presented as an LLM).
 *
 * Every AI response in this package and in `apps/server/src/routes/ai.ts`
 * carries the `engine` field so callers can tell which path produced it.
 *
 * Security: the API key (when set) is sent as a Bearer token over HTTPS and
 * is NEVER logged, NEVER included in error messages, and NEVER exposed via
 * {@link providerStatus} (which returns only engine/provider/model names).
 * Privacy: Kilo free models may log prompts upstream — Studio redacts
 * project secret values before any LLM call (see redactForLLM), and operators
 * should not send confidential data through the free tier (see docs).
 */

export type AIEngine = "rules" | "llm";

export interface AICompleteOptions {
  systemPrompt?: string;
  /** Ask the endpoint for a JSON object response (OpenAI response_format). */
  jsonMode?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface AIProvider {
  readonly name: string;
  readonly engine: AIEngine;
  complete(prompt: string, opts?: AICompleteOptions): Promise<string>;
}

/** Always-available deterministic fallback. No network, no secrets. */
export class RuleProvider implements AIProvider {
  readonly name = "rule-based";
  readonly engine: AIEngine = "rules";

  async complete(prompt: string, _opts?: AICompleteOptions): Promise<string> {
    // Generic completion has no deterministic answer; callers use the
    // specialised rule engines (nl-to-steps / explain / cleanup) instead.
    // This stub exists so the interface stays total without faking output.
    return JSON.stringify({
      engine: "rules",
      note: "No LLM key configured — use the deterministic rule engines (nlToSteps, explainFailureRule, cleanupRecording).",
      promptChars: prompt.length,
    });
  }
}

export interface EnvProviderConfig {
  baseUrl: string;
  /** May be empty for keyless gateways (Kilo free tier) — then no auth header is sent. */
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export const DEFAULT_AI_TIMEOUT_MS = 30_000;
export const DEFAULT_AI_MODEL = "gpt-4o-mini";
export const DEFAULT_AI_BASE_URL = "https://api.openai.com/v1";
export const KILO_BASE_URL = "https://api.kilo.ai/api/gateway/v1";
export const KILO_DEFAULT_MODEL = "kilo-auto/free";
export const UNCLOSEAI_BASE_URL = "https://hermes.ai.unturf.com/v1";
export const UNCLOSEAI_DEFAULT_MODEL = "turboderp/Qwen3.8-27B-exl3";

/**
 * Read LLM config from env. Returns null when no LLM is configured
 * (the caller must then fall back to {@link RuleProvider}).
 * - `AI_API_KEY` set → OpenAI-compatible endpoint (`AI_BASE_URL`/`AI_MODEL`
 *   have safe defaults; only the key gates).
 * - `AI_PROVIDER=kilo|uncloseai` → keyless free tier, NO key required
 *   (anonymous, rate-limited). `AI_MODEL` overrides the provider default;
 *   `AI_API_KEY`, when also set, is sent as Bearer (raises limits / unlocks
 *   paid models on Kilo).
 */
export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): EnvProviderConfig | null {
  const provider = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (provider === "kilo" || provider === "uncloseai") {
    const keyless = provider === "kilo"
      ? { baseUrl: KILO_BASE_URL, model: KILO_DEFAULT_MODEL }
      : { baseUrl: UNCLOSEAI_BASE_URL, model: UNCLOSEAI_DEFAULT_MODEL };
    const baseUrl = (env.AI_BASE_URL ?? keyless.baseUrl).trim().replace(/\/$/, "") || keyless.baseUrl;
    const model = (env.AI_MODEL ?? keyless.model).trim() || keyless.model;
    return { baseUrl, apiKey: (env.AI_API_KEY ?? "").trim(), model, timeoutMs: readTimeout(env) };
  }
  const apiKey = (env.AI_API_KEY ?? "").trim();
  if (!apiKey) return null;
  const baseUrl = (env.AI_BASE_URL ?? DEFAULT_AI_BASE_URL).trim().replace(/\/$/, "") || DEFAULT_AI_BASE_URL;
  const model = (env.AI_MODEL ?? DEFAULT_AI_MODEL).trim() || DEFAULT_AI_MODEL;
  return { baseUrl, apiKey, model, timeoutMs: readTimeout(env) };
}

function readTimeout(env: NodeJS.ProcessEnv): number {
  const timeoutRaw = Number(env.AI_TIMEOUT_MS ?? DEFAULT_AI_TIMEOUT_MS);
  return Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(Math.floor(timeoutRaw), 120_000) : DEFAULT_AI_TIMEOUT_MS;
}

/** OpenAI-compatible chat-completions provider (fetch, timeout, no key leaks). */
export class EnvProvider implements AIProvider {
  readonly name = "env-openai-compatible";
  readonly engine: AIEngine = "llm";
  readonly model: string;

  constructor(private readonly cfg: EnvProviderConfig) {
    this.model = cfg.model;
  }

  get baseUrl(): string {
    return this.cfg.baseUrl;
  }

  async complete(prompt: string, opts?: AICompleteOptions): Promise<string> {
    const timeoutMs = opts?.timeoutMs ?? this.cfg.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const messages: Array<{ role: string; content: string }> = [];
      if (opts?.systemPrompt) messages.push({ role: "system", content: opts.systemPrompt });
      messages.push({ role: "user", content: prompt });
      const body: Record<string, unknown> = { model: this.cfg.model, messages };
      if (opts?.jsonMode) body.response_format = { type: "json_object" };
      if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
      let res: Response;
      try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        // Keyless gateways (Kilo free) get no auth header at all.
        if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
        res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new Error(`AI provider timed out after ${timeoutMs}ms`);
        }
        throw new Error(`AI provider unreachable: ${(err as Error).message}`);
      }
      if (!res.ok) {
        // Status only — never echo headers/body (they may carry key material).
        throw new Error(`AI provider responded with HTTP ${res.status} (check AI_BASE_URL/AI_MODEL)`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || text.length === 0) {
        throw new Error("AI provider returned an empty completion");
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Factory: LLM when `AI_API_KEY` (or `AI_PROVIDER=kilo|uncloseai[,…]`) is
 * configured, otherwise the deterministic rule provider. Callers MUST
 * surface `provider.engine` in their response.
 *
 * `AI_PROVIDER` accepts a comma list (`kilo,uncloseai`) tried IN ORDER —
 * first success wins, total failure throws (callers fall back to rules).
 * Tokens: `kilo`, `uncloseai`, `key` (= classic `AI_API_KEY` endpoint).
 * Unknown tokens are dropped; an empty chain yields {@link RuleProvider}
 * (visible as `engine: 'rules'` in `/ai/status`, never a crash).
 *
 * `opts.model` overrides the model for EVERY EnvProvider built (per-task
 * routing, e.g. a stronger reasoning model for failure explanation while
 * interactive tasks stay on the cheap default). It never conjures an
 * endpoint: with no LLM configured the result is still {@link RuleProvider}.
 */
export interface SelectProviderOpts {
  /** Override the model for all LLM providers built by this call. */
  model?: string;
}

export function selectProvider(env: NodeJS.ProcessEnv = process.env, opts: SelectProviderOpts = {}): AIProvider {
  const modelOverride = (opts.model ?? "").trim() || undefined;
  const tokens = (env.AI_PROVIDER ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    const cfg = readEnvConfig(env);
    if (!cfg) return new RuleProvider();
    return new EnvProvider(modelOverride ? { ...cfg, model: modelOverride } : cfg);
  }
  const seen = new Set<string>();
  const chain: EnvProvider[] = [];
  for (const token of tokens) {
    const cfg = configForToken(token, env);
    if (!cfg) continue;
    const effective = modelOverride ? { ...cfg, model: modelOverride } : cfg;
    const key = `${effective.baseUrl}|${effective.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chain.push(new EnvProvider(effective));
  }
  if (chain.length === 0) return new RuleProvider();
  if (chain.length === 1) return chain[0]!;
  return new FallbackProvider(chain);
}

function configForToken(token: string, env: NodeJS.ProcessEnv): EnvProviderConfig | null {
  if (token === "kilo" || token === "uncloseai") {
    const keyless = token === "kilo"
      ? { baseUrl: KILO_BASE_URL, model: KILO_DEFAULT_MODEL }
      : { baseUrl: UNCLOSEAI_BASE_URL, model: UNCLOSEAI_DEFAULT_MODEL };
    const baseUrl = (env.AI_BASE_URL ?? keyless.baseUrl).trim().replace(/\/$/, "") || keyless.baseUrl;
    const model = (env.AI_MODEL ?? keyless.model).trim() || keyless.model;
    return { baseUrl, apiKey: (env.AI_API_KEY ?? "").trim(), model, timeoutMs: readTimeout(env) };
  }
  if (token === "key" || token === "env" || token === "openai") {
    return readEnvConfig(env);
  }
  return null;
}

/**
 * Tries LLM providers in order; first success wins. Total failure rethrows
 * the LAST error so callers can fall back to rules (and log something real).
 * `engine` stays `'llm'` — the response came from an LLM, whichever one.
 */
export class FallbackProvider implements AIProvider {
  readonly engine: AIEngine = "llm";
  readonly name: string;
  readonly models: string[];

  constructor(readonly chain: EnvProvider[]) {
    if (chain.length === 0) throw new Error("FallbackProvider needs at least one provider");
    this.models = chain.map((p) => p.model);
    this.name = `fallback(${chain.map((p) => providerShortName(p)).join("+")})`;
  }

  async complete(prompt: string, opts?: AICompleteOptions): Promise<string> {
    let lastErr: unknown = new Error("no providers in chain");
    for (const p of this.chain) {
      try {
        return await p.complete(prompt, opts);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

function providerShortName(p: EnvProvider): string {
  if (p.baseUrl === KILO_BASE_URL) return "kilo";
  if (p.baseUrl === UNCLOSEAI_BASE_URL) return "uncloseai";
  return "key";
}

/**
 * Model identity for cache keys (per-task routing means the same prompt
 * under a different model is a different entry).
 */
function providerModelTag(p: AIProvider): string {
  if (p instanceof EnvProvider) return p.model;
  if (p instanceof FallbackProvider) return p.models.join(",");
  return "";
}

export interface LlmCacheOpts {
  /** Max entries (LRU eviction). Default 200. */
  maxEntries?: number;
  /** TTL per entry in ms. Default 15 min. */
  ttlMs?: number;
}

const DEFAULT_CACHE_MAX = 200;
const DEFAULT_CACHE_TTL_MS = 15 * 60_000;

interface CacheEntry {
  text: string;
  expiresAt: number;
}

/**
 * In-memory LLM result cache by input hash (P2 backlog: dedupe repeat
 * explanations/completions — e.g. re-clicking "Explain with AI" on the same
 * failed run, or suite-retried identical failures).
 *
 * - Key = sha256(provider name + model tag + systemPrompt + jsonMode +
 *   maxTokens + prompt). Only successful completions are cached; errors
 *   always pass through (a transient 429 must never poison later calls).
 * - Wraps LLM providers only — callers leave {@link RuleProvider} unwrapped
 *   (local, deterministic, ~free; caching it would only hide staleness).
 * - Process memory only, never persisted; prompts reaching this layer are
 *   already secret-redacted by the server route (`redactForLLM`).
 * - `AI_CACHE=0` disables (every call passes through, stats still count
 *   misses). `AI_CACHE_MAX` / `AI_CACHE_TTL_MS` tune size/TTL.
 */
export class CachedProvider implements AIProvider {
  readonly engine: AIEngine = "llm";
  readonly name: string;
  private readonly store = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly inner: AIProvider,
    private readonly opts: LlmCacheOpts = {},
  ) {
    this.name = `cached(${inner.name})`;
  }

  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.store.size };
  }

  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  async complete(prompt: string, opts?: AICompleteOptions): Promise<string> {
    const maxEntries = this.opts.maxEntries ?? DEFAULT_CACHE_MAX;
    const ttlMs = this.opts.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    const { createHash } = await import("node:crypto");
    const key = createHash("sha256")
      .update(
        JSON.stringify({
          p: this.inner.name,
          m: providerModelTag(this.inner),
          s: opts?.systemPrompt ?? "",
          j: opts?.jsonMode ?? false,
          t: opts?.maxTokens ?? 0,
          q: prompt,
        }),
        "utf8",
      )
      .digest("hex");
    const now = Date.now();
    const hit = this.store.get(key);
    if (hit && hit.expiresAt > now) {
      // LRU refresh: re-insert to mark most-recently-used.
      this.store.delete(key);
      this.store.set(key, hit);
      this.hits += 1;
      return hit.text;
    }
    if (hit) this.store.delete(key);
    this.misses += 1;
    const text = await this.inner.complete(prompt, opts);
    this.store.set(key, { text, expiresAt: now + ttlMs });
    while (this.store.size > maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
    return text;
  }
}

function cacheDisabled(env: NodeJS.ProcessEnv): boolean {
  return (env.AI_CACHE ?? "").trim() === "0";
}

function readCacheOpts(env: NodeJS.ProcessEnv): LlmCacheOpts {
  const out: LlmCacheOpts = {};
  const maxRaw = Number(env.AI_CACHE_MAX ?? "");
  if (Number.isFinite(maxRaw) && maxRaw > 0) out.maxEntries = Math.floor(Math.min(maxRaw, 10_000));
  const ttlRaw = Number(env.AI_CACHE_TTL_MS ?? "");
  if (Number.isFinite(ttlRaw) && ttlRaw > 0) out.ttlMs = Math.floor(Math.min(ttlRaw, 24 * 3_600_000));
  return out;
}

/**
 * Wrap an LLM provider in {@link CachedProvider}; rules (and cache-disabled
 * envs) pass through untouched. Identity-stable per process — call sites
 * SHOULD reuse one wrapper (e.g. module-level in the server) so repeat
 * calls actually hit; a fresh wrapper per request caches nothing.
 */
export function withLlmCache(provider: AIProvider, env: NodeJS.ProcessEnv = process.env): AIProvider {
  if (provider.engine !== "llm" || cacheDisabled(env)) return provider;
  return new CachedProvider(provider, readCacheOpts(env));
}

/**
 * Public status payload — safe to expose via GET /ai/status.
 * NEVER includes the key, the full base URL credentials, or secrets.
 */
export function providerStatus(provider: AIProvider): {
  engine: AIEngine;
  provider: string;
  model?: string;
} {
  if (provider instanceof FallbackProvider) {
    return { engine: "llm", provider: provider.name, model: provider.models.join(",") };
  }
  if (provider instanceof EnvProvider) {
    return { engine: "llm", provider: provider.name, model: provider.model };
  }
  return { engine: "rules", provider: provider.name };
}
