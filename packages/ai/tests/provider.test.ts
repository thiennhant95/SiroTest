import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  CachedProvider,
  EnvProvider,
  FallbackProvider,
  RuleProvider,
  providerStatus,
  readEnvConfig,
  selectProvider,
  withLlmCache,
  type AICompleteOptions,
  type AIProvider,
} from "../src/provider";

describe("selectProvider", () => {
  it("returns rules when no key is configured", () => {
    const p = selectProvider({ PATH: "x" } as NodeJS.ProcessEnv);
    expect(p).toBeInstanceOf(RuleProvider);
    expect(p.engine).toBe("rules");
  });

  it("returns the Kilo keyless provider when AI_PROVIDER=kilo", () => {
    const p = selectProvider({ AI_PROVIDER: "kilo" } as NodeJS.ProcessEnv);
    expect(p).toBeInstanceOf(EnvProvider);
    expect(p.engine).toBe("llm");
    expect((p as EnvProvider).model).toBe("kilo-auto/free");
    expect((p as EnvProvider).baseUrl).toBe("https://api.kilo.ai/api/gateway/v1");
  });

  it("returns the uncloseai keyless provider when AI_PROVIDER=uncloseai", () => {
    const p = selectProvider({ AI_PROVIDER: "uncloseai" } as NodeJS.ProcessEnv);
    expect(p).toBeInstanceOf(EnvProvider);
    expect(p.engine).toBe("llm");
    expect((p as EnvProvider).model).toBe("turboderp/Qwen3.8-27B-exl3");
    expect((p as EnvProvider).baseUrl).toBe("https://hermes.ai.unturf.com/v1");
  });

  it("builds an ordered fallback chain for comma lists", () => {
    const p = selectProvider({ AI_PROVIDER: "kilo,uncloseai" } as NodeJS.ProcessEnv);
    expect(p).toBeInstanceOf(FallbackProvider);
    const chain = (p as FallbackProvider).chain;
    expect(chain.map((c) => c.model)).toEqual(["kilo-auto/free", "turboderp/Qwen3.8-27B-exl3"]);
    expect(providerStatus(p)).toEqual({
      engine: "llm",
      provider: "fallback(kilo+uncloseai)",
      model: "kilo-auto/free,turboderp/Qwen3.8-27B-exl3",
    });
  });

  it("unknown tokens yield rules (visible, never a crash)", () => {
    const p = selectProvider({ AI_PROVIDER: "killo" } as NodeJS.ProcessEnv);
    expect(p).toBeInstanceOf(RuleProvider);
  });

  it("readEnvConfig: kilo honors AI_MODEL override + optional key", () => {
    const cfg = readEnvConfig({ AI_PROVIDER: "kilo", AI_MODEL: "openrouter/free", AI_API_KEY: "kilo-key" } as NodeJS.ProcessEnv)!;
    expect(cfg.model).toBe("openrouter/free");
    expect(cfg.apiKey).toBe("kilo-key");
  });

  it("readEnvConfig applies safe defaults", () => {
    const cfg = readEnvConfig({ AI_API_KEY: "k" } as NodeJS.ProcessEnv)!;
    expect(cfg.model).toBe("gpt-4o-mini");
    expect(cfg.baseUrl).toBe("https://api.openai.com/v1");
    expect(cfg.timeoutMs).toBe(30_000);
  });

  it("status never leaks the key", () => {
    const p = selectProvider({ AI_API_KEY: "sk-super-secret" } as NodeJS.ProcessEnv);
    const s = providerStatus(p);
    expect(JSON.stringify(s)).not.toMatch(/sk-super-secret/);
    expect(s).toEqual({ engine: "llm", provider: "env-openai-compatible", model: "gpt-4o-mini" });
  });

  it("rule status shape", () => {
    expect(providerStatus(new RuleProvider())).toEqual({ engine: "rules", provider: "rule-based" });
  });

  it("model override applies to single + chain, never conjures an endpoint", () => {
    const single = selectProvider({ AI_API_KEY: "k", AI_MODEL: "cheap" } as NodeJS.ProcessEnv, { model: "pro" });
    expect(single).toBeInstanceOf(EnvProvider);
    expect((single as EnvProvider).model).toBe("pro");

    const chained = selectProvider({ AI_PROVIDER: "kilo,uncloseai" } as NodeJS.ProcessEnv, { model: "pro" });
    expect(chained).toBeInstanceOf(FallbackProvider);
    expect((chained as FallbackProvider).chain.map((c) => c.model)).toEqual(["pro", "pro"]);
    expect(providerStatus(chained).model).toBe("pro,pro");

    // Override alone conjures nothing: no LLM configured → still rules.
    const none = selectProvider({ PATH: "x" } as NodeJS.ProcessEnv, { model: "pro" });
    expect(none).toBeInstanceOf(RuleProvider);
    expect(none.engine).toBe("rules");
  });
});

describe("CachedProvider (LLM result cache by input hash)", () => {
  function stubInner(replies: Array<string | Error>): { provider: AIProvider; calls: string[] } {
    const calls: string[] = [];
    let n = 0;
    const provider: AIProvider = {
      name: "stub-llm",
      engine: "llm",
      complete: async (prompt: string, _opts?: AICompleteOptions) => {
        calls.push(prompt);
        const next = replies[Math.min(n++, replies.length - 1)]!;
        if (next instanceof Error) throw next;
        return next;
      },
    };
    return { provider, calls };
  }

  it("repeats hit the cache; different inputs miss", async () => {
    const { provider, calls } = stubInner(["one", "two"]);
    const cached = new CachedProvider(provider);
    expect(await cached.complete("same")).toBe("one");
    expect(await cached.complete("same")).toBe("one");
    expect(await cached.complete("other")).toBe("two");
    expect(calls).toEqual(["same", "other"]);
    expect(cached.stats()).toEqual({ hits: 1, misses: 2, size: 2 });
  });

  it("opts (systemPrompt/jsonMode/maxTokens) partition the key", async () => {
    const { provider, calls } = stubInner(["a", "b"]);
    const cached = new CachedProvider(provider);
    await cached.complete("q", { systemPrompt: "s1" });
    await cached.complete("q", { systemPrompt: "s2" });
    expect(calls).toEqual(["q", "q"]);
  });

  it("errors are never cached", async () => {
    const { provider, calls } = stubInner([new Error("boom-429"), "recovered"]);
    const cached = new CachedProvider(provider);
    await expect(cached.complete("q")).rejects.toThrowError(/boom-429/);
    expect(await cached.complete("q")).toBe("recovered");
    expect(calls).toEqual(["q", "q"]);
    expect(cached.stats().size).toBe(1);
  });

  it("TTL expiry re-fetches", async () => {
    const { provider } = stubInner(["v1", "v2"]);
    const cached = new CachedProvider(provider, { ttlMs: 5 });
    expect(await cached.complete("q")).toBe("v1");
    await new Promise((r) => setTimeout(r, 15));
    expect(await cached.complete("q")).toBe("v2");
  });

  it("LRU evicts the oldest entry past maxEntries", async () => {
    const { provider, calls } = stubInner(["1", "2", "3", "1-again"]);
    const cached = new CachedProvider(provider, { maxEntries: 2 });
    await cached.complete("a");
    await cached.complete("b");
    await cached.complete("c"); // evicts "a"
    await cached.complete("a");
    expect(calls).toEqual(["a", "b", "c", "a"]);
  });

  it("withLlmCache passes rules through and honors AI_CACHE=0", () => {
    expect(withLlmCache(new RuleProvider())).toBeInstanceOf(RuleProvider);
    const llm: AIProvider = { name: "x", engine: "llm", complete: async () => "y" };
    expect(withLlmCache(llm, { AI_CACHE: "0" } as NodeJS.ProcessEnv)).toBe(llm);
    expect(withLlmCache(llm, {} as NodeJS.ProcessEnv)).toBeInstanceOf(CachedProvider);
  });

  it("providerStatus sees through the cache (llm stays llm)", () => {
    const inner = new EnvProvider({ baseUrl: "https://llm.example.com", apiKey: "k", model: "m", timeoutMs: 5000 });
    const cached = new CachedProvider(inner);
    expect(providerStatus(cached)).toEqual({ engine: "llm", provider: "env-openai-compatible", model: "m" });
  });
});

describe("EnvProvider (mocked fetch — no real network)", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllGlobals();
  });

  it("posts OpenAI-compatible chat completions and returns text", async () => {
    const seen: { url?: string; headers?: Record<string, string>; body?: string } = {};
    vi.stubGlobal(
      "fetch",
      (async (url: string, init: { headers: Record<string, string>; body: string }) => {
        seen.url = url;
        seen.headers = init.headers;
        seen.body = init.body;
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: '{"steps":[]}' } }] }),
        };
      }) as typeof fetch,
    );
    const p = new EnvProvider({ baseUrl: "https://llm.example.com/v1", apiKey: "k", model: "m", timeoutMs: 5000 });
    const text = await p.complete("hello", { jsonMode: true });
    expect(text).toBe('{"steps":[]}');
    expect(seen.url).toBe("https://llm.example.com/v1/chat/completions");
    expect(seen.headers?.authorization).toBe("Bearer k");
    expect(JSON.parse(seen.body!).response_format).toEqual({ type: "json_object" });
  });

  it("redacts secrets from HTTP-error messages", async () => {
    vi.stubGlobal(
      "fetch",
      (async () => ({ ok: false, status: 401, json: async () => ({}) })) as typeof fetch,
    );
    const p = new EnvProvider({ baseUrl: "https://llm.example.com", apiKey: "sk-SECRET-KEY", model: "m", timeoutMs: 5000 });
    await expect(p.complete("hi")).rejects.toThrowError(/HTTP 401/);
    await expect(p.complete("hi")).rejects.toThrowError(/^(?!.*SECRET).*$/);
  });

  it("omits the auth header for keyless gateways", async () => {
    const seen: { headers?: Record<string, string> } = {};
    vi.stubGlobal(
      "fetch",
      (async (_url: string, init: { headers: Record<string, string> }) => {
        seen.headers = init.headers;
        return { ok: true, json: async () => ({ choices: [{ message: { content: "hi" } }] }) };
      }) as typeof fetch,
    );
    const p = new EnvProvider({ baseUrl: "https://api.kilo.ai/api/gateway", apiKey: "", model: "kilo-auto/free", timeoutMs: 5000 });
    expect(await p.complete("hello")).toBe("hi");
    expect(seen.headers).not.toHaveProperty("authorization");
  });

  it("fallback tries in order and throws the last error when all fail", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async (url: string) => {
        calls.push(url);
        if (url.includes("kilo")) return { ok: false, status: 429, json: async () => ({}) };
        return { ok: true, json: async () => ({ choices: [{ message: { content: "second-wins" } }] }) };
      }) as typeof fetch,
    );
    const p = selectProvider({ AI_PROVIDER: "kilo,uncloseai" } as NodeJS.ProcessEnv);
    expect(await p.complete("hi")).toBe("second-wins");
    expect(calls[0]).toContain("kilo");
    expect(calls[1]).toContain("unturf");

    vi.stubGlobal("fetch", (async () => ({ ok: false, status: 500, json: async () => ({}) })) as typeof fetch);
    await expect(p.complete("hi")).rejects.toThrowError(/HTTP 500/);
  });

  it("reports timeouts without leaking the key", async () => {
    vi.stubGlobal(
      "fetch",
      ((..._a: unknown[]) => new Promise((_res, rej) => {
        const e = new DOMException("aborted", "AbortError");
        setTimeout(() => rej(e), 5);
      })) as typeof fetch,
    );
    const p = new EnvProvider({ baseUrl: "https://llm.example.com", apiKey: "sk-SECRET", model: "m", timeoutMs: 20 });
    await expect(p.complete("hi")).rejects.toThrowError(/timed out|unreachable/);
  }, 10000);
});
