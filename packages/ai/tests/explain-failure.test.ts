import { describe, expect, it } from "vitest";
import { buildExplainPrompt, explainFailure, explainFailureRule } from "../src/explain-failure";
import { RuleProvider } from "../src/provider";

describe("explainFailureRule categories", () => {
  it("classifies strict-mode locator failures", () => {
    const e = explainFailureRule({
      errorSummary: "locator.click: strict mode violation: getByRole('button') resolved to 3 elements",
      stepType: "click",
      locator: { primary: { strategy: "role", role: "button", name: "OK" } },
    });
    expect(e.category).toBe("locator-not-found");
    expect(e.confidence).toBe("high");
    expect(e.suggestedFixes.join(" ")).toMatch(/Test locator/i);
  });

  it("classifies missing-element locator failures", () => {
    const e = explainFailureRule({
      errorSummary: "Timeout 5000ms exceeded waiting for locator getByLabel('Email')",
      stepType: "fill",
      timeoutMs: 5000,
    });
    expect(e.category).toBe("locator-not-found");
    expect(e.suggestedFixes.join(" ")).toMatch(/5000ms/);
  });

  it("classifies plain timeouts", () => {
    const e = explainFailureRule({
      errorSummary: "Test timeout of 30000ms exceeded while running",
      stepType: "goto",
    });
    expect(e.category).toBe("timeout");
  });

  it("classifies assertion mismatches", () => {
    const e = explainFailureRule({
      errorSummary: "expect(locator).toHaveText(expected 'Hi' but received 'Hello')",
      stepType: "assertText",
    });
    expect(e.category).toBe("assert-mismatch");
    expect(e.confidence).toBe("high");
  });

  it("classifies vanished-element expect() errors as locator-not-found", () => {
    const e = explainFailureRule({
      errorSummary:
        "Error: expect(locator).toBeVisible() failed\nLocator: locator('#nope')\nTimeout: 5000ms\nError: element(s) not found",
      stepType: "assertVisible",
    });
    expect(e.category).toBe("locator-not-found");
    expect(e.confidence).toBe("high");
  });

  it("classifies navigation errors", () => {
    const e = explainFailureRule({
      errorSummary: "page.goto: net::ERR_CONNECTION_REFUSED at https://shop.example.com/",
      stepType: "goto",
    });
    expect(e.category).toBe("navigation");
  });

  it("falls back to unknown with low confidence", () => {
    const e = explainFailureRule({ errorSummary: "something completely unexpected happened" });
    expect(e.category).toBe("unknown");
    expect(e.confidence).toBe("low");
  });

  it("mentions stored alternatives when present", () => {
    const withAlt = explainFailureRule({
      errorSummary: "locator.click: element not found",
      stepType: "click",
      locator: {
        primary: { strategy: "role", role: "button", name: "OK" },
        alternatives: [{ strategy: "text", value: "OK" }],
      },
    });
    const withoutAlt = explainFailureRule({
      errorSummary: "locator.click: element not found",
      stepType: "click",
      locator: { primary: { strategy: "role", role: "button", name: "OK" } },
    });
    expect(withAlt.suggestedFixes.join(" ")).toMatch(/alternatives/);
    expect(withoutAlt.suggestedFixes.join(" ")).toMatch(/chưa có locator dự phòng/);
  });
});

describe("explainFailure provider wiring", () => {
  it("rule provider reports engine rules", async () => {
    const r = await explainFailure({ errorSummary: "boom" }, new RuleProvider());
    expect(r.engine).toBe("rules");
    expect(r.explanation.category).toBe("unknown");
  });

  it("defaults to rules without a provider", async () => {
    const r = await explainFailure({ errorSummary: "expect(x).toBeVisible failed" });
    expect(r.engine).toBe("rules");
    expect(r.explanation.category).toBe("assert-mismatch");
  });

  it("prompt template carries the failure fields", () => {
    const p = buildExplainPrompt({ errorSummary: "E1", stepType: "click", timeoutMs: 1000 });
    expect(p).toMatch(/click/);
    expect(p).toMatch(/1000/);
    expect(p).toMatch(/E1/);
  });

  it("prompt carries run context when provided", () => {
    const p = buildExplainPrompt({
      errorSummary: "TimeoutError: Step timeout of 15000ms exceeded.",
      stepType: "assertVisible",
      stepName: "Vao mypage",
      testName: "om01-dang-ky",
      priorSummary: "5/5 prior steps passed before failed step s-assert",
    });
    expect(p).toMatch(/om01-dang-ky/);
    expect(p).toMatch(/5\/5 prior steps passed/);
  });

  it("prompt teaches assert-after-submit validation hypothesis + confidence cap", () => {
    const p = buildExplainPrompt({ errorSummary: "timeout", stepType: "assertVisible" });
    expect(p).toMatch(/NEVER NAVIGATED/);
    expect(p).toMatch(/validation/);
    expect(p).toMatch(/most 'medium'/);
  });
});
