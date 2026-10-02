import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseTestDefinition, safeParseTestDefinition } from "../src/schemas";
import { migrateTestDefinition, UnsupportedSchemaVersionError } from "../src/migrations";

function loadLoginExample(): unknown {
  // packages/test-model/tests -> ../../examples/login-test.json
  const p = path.resolve(__dirname, "../../../examples/login-test.json");
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

describe("test-model P0", () => {
  it("parses examples/login-test.json", () => {
    const def = parseTestDefinition(loadLoginExample());
    expect(def.schemaVersion).toBe("1.0");
    expect(def.steps.map((s) => s.type)).toEqual([
      "goto",
      "fill",
      "fill",
      "click",
      "assertVisible",
    ]);
  });

  it("does not mutate the input object", () => {
    const raw = loadLoginExample() as Record<string, unknown>;
    const snapshot = JSON.stringify(raw);
    parseTestDefinition(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });

  it("rejects unknown step type", () => {
    const raw = loadLoginExample() as any;
    raw.steps = [{ id: "sX", type: "aiMagic", enabled: true }];
    expect(() => parseTestDefinition(raw)).toThrow();
    expect(safeParseTestDefinition(raw).success).toBe(false);
  });

  it("rejects wrong schemaVersion via migration stub", () => {
    const raw = loadLoginExample() as Record<string, unknown>;
    const bad = { ...raw, schemaVersion: "2.0" };
    expect(() => migrateTestDefinition(bad)).toThrow(UnsupportedSchemaVersionError);
  });

  it("migrateTestDefinition passes through v1.0", () => {
    const def = migrateTestDefinition(loadLoginExample());
    expect(def.schemaVersion).toBe("1.0");
  });

  it("requires url|pattern for waitForURL / assertURL", () => {
    expect(
      safeParseTestDefinition({
        schemaVersion: "1.0",
        id: "t1",
        projectId: "p1",
        name: "t",
        browser: "chromium",
        steps: [{ id: "s1", type: "waitForURL", enabled: true }],
      }).success,
    ).toBe(false);
  });
});
