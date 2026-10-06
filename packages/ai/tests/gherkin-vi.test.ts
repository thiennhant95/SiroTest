import { describe, expect, it, beforeEach } from "vitest";
import { testStepSchema } from "@playwright-studio/test-model";
import { resetNlStepCounter } from "../src/nl-to-steps";
import { gherkinViToSteps, resetGherkinStepCounter } from "../src/gherkin-vi";

beforeEach(() => {
  resetNlStepCounter();
  resetGherkinStepCounter();
});

function assertAllValid(steps: unknown[]): void {
  for (const s of steps) {
    expect(testStepSchema.safeParse(s).success).toBe(true);
  }
}

const FULL_VI_LOGIN = `@smoke @login
Tính năng: Đăng nhập admin
  Bối cảnh:
    Cho rằng mở trang https://test.aloa.asia/admin/login
  Kịch bản: Login thành công
    Khi nhập "Email Address" là "admin@x.io"
    Và nhập "Password" là "123456"
    Và bấm nút "Sign In"
    Thì kiểm tra "Dashboard" hiển thị
  Kịch bản: Login sai mật khẩu
    Khi nhập "Mật khẩu" là "sai"
    Và nhấn "Sign In"
    Thì kiểm tra "Email hoặc mật khẩu không đúng" hiển thị`;

describe("gherkin-vi full login flow", () => {
  it("parses background + first scenario, warns on the second scenario", () => {
    const r = gherkinViToSteps(FULL_VI_LOGIN);
    expect(r.steps.map((s) => s.type)).toEqual(["goto", "fill", "fill", "click", "assertVisible"]);
    expect(r.steps.map((s) => s.id)).toEqual(["g1", "g2", "g3", "g4", "g5"]);
    assertAllValid(r.steps);
    expect(r.unparsed).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("Login sai mật khẩu");
    expect(r.scenarioName).toBe("Login thành công");
    expect(r.tags).toEqual(["smoke", "login"]);
    const goto = r.steps[0] as { url: string };
    expect(goto.url).toBe("https://test.aloa.asia/admin/login");
    const pw = r.steps[2] as { value: string; sensitive?: boolean };
    expect(pw.value).toBe("123456");
    expect(pw.sensitive).toBe(true);
  });

  it("is deterministic across calls", () => {
    resetGherkinStepCounter();
    const first = gherkinViToSteps(FULL_VI_LOGIN);
    resetGherkinStepCounter();
    resetNlStepCounter();
    const second = gherkinViToSteps(FULL_VI_LOGIN);
    expect(second).toEqual(first);
  });
});

describe("gherkin-vi EN fallback keywords", () => {
  it("parses Given/When/Then/And + Background/Scenario in English", () => {
    const r = gherkinViToSteps(`@fast
Feature: Login
  Background:
    Given open https://example.com
  Scenario: Happy path
    When fill "Email" with "a@x.io"
    And click "Sign In"
    Then verify "Dashboard" is visible`);
    expect(r.steps.map((s) => s.type)).toEqual(["goto", "fill", "click", "assertVisible"]);
    assertAllValid(r.steps);
    expect(r.unparsed).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.scenarioName).toBe("Happy path");
    expect(r.tags).toEqual(["fast"]);
  });

  it("accepts headers without a trailing colon and any letter case", () => {
    const r = gherkinViToSteps(`CHỨC NĂNG Đăng nhập
bối cảnh
cho rằng mở trang https://example.com
KỊCH BẢN Thành công
khi bấm nút "OK"`);
    expect(r.steps.map((s) => s.type)).toEqual(["goto", "click"]);
    assertAllValid(r.steps);
    expect(r.unparsed).toEqual([]);
    expect(r.scenarioName).toBe("Thành công");
  });
});

describe("gherkin-vi And/But inheritance", () => {
  it("Và/Nhưng inherit the current section", () => {
    const r = gherkinViToSteps(`Kịch bản: Kế thừa
  Khi bấm nút "A"
  Và bấm nút "B"
  Nhưng bấm nút "C"`);
    expect(r.steps.map((s) => s.type)).toEqual(["click", "click", "click"]);
    assertAllValid(r.steps);
    expect(r.unparsed).toEqual([]);
  });

  it("Và without a preceding Given/When/Then is unparsed", () => {
    const r = gherkinViToSteps(`Kịch bản: Sai
  Và bấm nút "X"`);
    expect(r.steps).toEqual([]);
    expect(r.unparsed).toEqual([`Dòng 2: Và bấm nút "X"`]);
    expect(r.scenarioName).toBe("Sai");
  });

  it("section resets for each new block", () => {
    const r = gherkinViToSteps(`Bối cảnh:
  Cho rằng mở trang https://example.com
Kịch bản: Đầu
  Và bấm nút "X"`);
    // Background step parses; Và in the scenario has no section there.
    expect(r.steps.map((s) => s.type)).toEqual(["goto"]);
    expect(r.unparsed).toEqual([`Dòng 4: Và bấm nút "X"`]);
  });
});

describe("gherkin-vi Examples/table/comments", () => {
  it("Ví dụ: and | table | rows are unparsed, never fatal", () => {
    const r = gherkinViToSteps(`Tính năng: Demo
  Kịch bản: Có ví dụ
    Cho rằng mở trang https://example.com
    Ví dụ:
      | user | pass |
      | a | b |
    Khi bấm nút "OK"`);
    expect(r.steps.map((s) => s.type)).toEqual(["goto", "click"]);
    assertAllValid(r.steps);
    expect(r.unparsed).toEqual([
      "Dòng 4: Ví dụ:",
      "Dòng 5: | user | pass |",
      "Dòng 6: | a | b |",
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("skips # comments and collects tags", () => {
    const r = gherkinViToSteps(`# bình luận đầu file
@smoke @login
Tính năng: Đăng nhập
  # bình luận trong feature
  Kịch bản: OK
    # bình luận trong scenario
    Khi bấm nút "OK"`);
    expect(r.steps.map((s) => s.type)).toEqual(["click"]);
    expect(r.unparsed).toEqual([]);
    expect(r.tags).toEqual(["smoke", "login"]);
    expect(r.scenarioName).toBe("OK");
  });

  it("unknown lines are unparsed with line numbers, not fabricated", () => {
    const r = gherkinViToSteps(`Kịch bản: Rác
  Khi bấm nút "OK"
  làm điều kỳ diệu với lượng tử
  Thì kiểm tra "X" hiển thị`);
    expect(r.steps.map((s) => s.type)).toEqual(["click", "assertVisible"]);
    expect(r.unparsed).toEqual(["Dòng 3: làm điều kỳ diệu với lượng tử"]);
  });
});
