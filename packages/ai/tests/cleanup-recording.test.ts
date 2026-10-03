import { describe, expect, it, beforeEach } from "vitest";
import { testStepSchema } from "@playwright-studio/test-model";
import { businessName, cleanupRecording, resetCleanupCounter } from "../src/cleanup-recording";

function label(value: string) {
  return { primary: { strategy: "label", value } };
}
function roleBtn(name: string) {
  return { primary: { strategy: "role", role: "button", name } };
}

beforeEach(() => resetCleanupCounter());

describe("cleanupRecording", () => {
  it("merges adjacent fills on the same target (keeps last value)", () => {
    const r = cleanupRecording([
      { id: "a", type: "fill", enabled: true, target: label("Email"), value: "t" },
      { id: "b", type: "fill", enabled: true, target: label("Email"), value: "tester@x.com" },
    ]);
    expect(r.steps.map((s) => s.type)).toEqual(["fill"]);
    expect((r.steps[0] as { value: string }).value).toBe("tester@x.com");
    expect(r.changes.some((c) => c.kind === "merge-fill")).toBe(true);
  });

  it("drops click-into-input immediately before a fill", () => {
    const r = cleanupRecording([
      { id: "a", type: "click", enabled: true, target: label("Email") },
      { id: "b", type: "fill", enabled: true, target: label("Email"), value: "x" },
      { id: "c", type: "click", enabled: true, target: roleBtn("Login") },
    ]);
    expect(r.steps.map((s) => (s as { id: string }).id)).toEqual(["b", "c"]);
    expect(r.changes.some((c) => c.kind === "drop-click-before-fill")).toBe(true);
  });

  it("collapses redirect goto chains keeping the last URL", () => {
    const r = cleanupRecording([
      { id: "a", type: "goto", enabled: true, url: "https://a.example.com" },
      { id: "b", type: "goto", enabled: true, url: "https://b.example.com/login" },
    ]);
    expect(r.steps).toHaveLength(1);
    expect((r.steps[0] as { url: string }).url).toBe("https://b.example.com/login");
    expect(r.changes.some((c) => c.kind === "merge-goto")).toBe(true);
  });

  it("assigns business-readable names only when missing", () => {
    const r = cleanupRecording([
      { id: "a", type: "goto", enabled: true, url: "https://x.example.com" },
      { id: "b", type: "click", enabled: true, name: "Custom name", target: roleBtn("OK") },
    ]);
    expect((r.steps[0] as { name: string }).name).toBe("Mở https://x.example.com");
    expect((r.steps[1] as { name: string }).name).toBe("Custom name");
    expect(r.changes.filter((c) => c.kind === "rename")).toHaveLength(1);
  });

  it("suggests assertions as reviewable changes (never auto-inserted)", () => {
    const r = cleanupRecording([
      { id: "a", type: "fill", enabled: true, target: label("Email"), value: "x" },
      { id: "b", type: "click", enabled: true, target: roleBtn("Login") },
    ]);
    // Steps themselves are untouched by suggestions…
    expect(r.steps.map((s) => s.type)).toEqual(["fill", "click"]);
    const suggestions = r.changes.filter((c) => c.kind === "suggest-assertion");
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]!.suggestedStep?.type).toBe("assertValue");
    expect(suggestions[1]!.suggestedStep?.type).toBe("assertVisible");
    for (const s of suggestions) {
      expect(testStepSchema.safeParse(s.suggestedStep).success).toBe(true);
    }
  });

  it("masks sensitive fill values in suggestions", () => {
    const r = cleanupRecording([
      { id: "a", type: "fill", enabled: true, target: label("Password"), value: "hunter2", sensitive: true },
    ]);
    const s = r.changes.find((c) => c.kind === "suggest-assertion")!;
    expect(s.suggestedStep?.expected).toBe("***MASKED***");
    // The stored step keeps its real value (no data loss); only the
    // review surface (changes[]) must never carry the secret.
    expect(JSON.stringify(r.changes)).not.toMatch(/hunter2/);
  });

  it("flags off-schema steps instead of dropping them silently", () => {
    const r = cleanupRecording([{ id: "a", type: "aiMagic", enabled: true }]);
    expect(r.steps).toHaveLength(1);
    expect(r.changes.some((c) => c.kind === "kept-unrecognized")).toBe(true);
  });

  it("businessName covers the P0 catalog", () => {
    expect(businessName({ type: "assertTitle" })).toBe("Kiểm tra tiêu đề");
    expect(businessName({ type: "waitForTimeout", milliseconds: 100 })).toBe("Chờ 100ms");
    expect(businessName({ type: "press", key: "Enter" })).toBe("Nhấn phím Enter");
  });
});
