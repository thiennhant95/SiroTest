import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  EnvProvider,
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

  it("returns the LLM provider when AI_API_KEY is set", () => {
    const p = selectProvider({ AI_API_KEY: "sk-test" } as NodeJS.ProcessEnv);
    expect(p).toBeInstanceOf(EnvProvider);
    expect(p.engine).toBe("llm");
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
