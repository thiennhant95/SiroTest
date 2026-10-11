import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  EnvProvider,
  FallbackProvider,
  RuleProvider,
  providerStatus,
  readEnvConfig,
  selectProvider,
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
