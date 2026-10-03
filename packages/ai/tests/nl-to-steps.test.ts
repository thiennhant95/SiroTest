import { describe, expect, it, beforeEach } from "vitest";
import { testStepSchema } from "@playwright-studio/test-model";
import { nlToSteps, resetNlStepCounter } from "../src/nl-to-steps";

beforeEach(() => resetNlStepCounter());

function assertAllValid(steps: unknown[]): void {
  for (const s of steps) {
    expect(testStepSchema.safeParse(s).success).toBe(true);
  }
}

describe("nl-to-steps (EN)", () => {
  it("parses goto + click + fill + assertVisible", () => {
    const r = nlToSteps(`open https://example.com
click "Login"
fill "Email" with "tester@example.com"
verify "Dashboard" is visible`);
    expect(r.unparsed).toEqual([]);
    expect(r.steps.map((s) => s.type)).toEqual(["goto", "click", "fill", "assertVisible"]);
    assertAllValid(r.steps);
    const goto = r.steps[0] as { url: string };
    expect(goto.url).toBe("https://example.com");
    const click = r.steps[1] as { target: { primary: { strategy: string; role: string; name: string } } };
    expect(click.target.primary.strategy).toBe("role");
    expect(click.target.primary.role).toBe("button");
  });

  it("parses API + select + wait + screenshot", () => {
    const r = nlToSteps(`API GET https://api.example.com/users
select "VN" in "Country"
wait 500ms
take a screenshot "final"`);
    expect(r.unparsed).toEqual([]);
    expect(r.steps.map((s) => s.type)).toEqual(["apiRequest", "select", "waitForTimeout", "screenshot"]);
    assertAllValid(r.steps);
  });

  it("parses press Enter and uncheck", () => {
    const r = nlToSteps(`press Enter
uncheck "Remember me"`);
    expect(r.unparsed).toEqual([]);
    expect(r.steps.map((s) => s.type)).toEqual(["press", "uncheck"]);
    assertAllValid(r.steps);
  });
});

describe("nl-to-steps (VI)", () => {
  it("parses a full Vietnamese login flow", () => {
    const r = nlToSteps(`Mở trang https://shop.example.com
Nhập "tester@example.com" vào ô "Email"
Nhập "secret" vào ô "Mật khẩu"
Nhấn nút "Đăng nhập"
Kiểm tra "Dashboard" hiển thị`);
    expect(r.unparsed).toEqual([]);
    expect(r.steps.map((s) => s.type)).toEqual(["goto", "fill", "fill", "click", "assertVisible"]);
    assertAllValid(r.steps);
    const pw = r.steps[2] as { sensitive?: boolean };
    expect(pw.sensitive).toBe(true);
  });

  it("parses chờ N giây + chọn trong ô + URL/title assertions", () => {
    const r = nlToSteps(`Chờ 2 giây
Chờ "Dashboard" xuất hiện
Chọn "Hà Nội" trong ô "Tỉnh thành"
Kiểm tra URL chứa "/dashboard"
Kiểm tra tiêu đề là "Shop"`);
    expect(r.unparsed).toEqual([]);
    expect(r.steps.map((s) => s.type)).toEqual([
      "waitForTimeout",
      "waitForElement",
      "select",
      "assertURL",
      "assertTitle",
    ]);
    assertAllValid(r.steps);
    expect((r.steps[0] as { milliseconds: number }).milliseconds).toBe(2000);
  });

  it("parses new tab + reload + bare assertions", () => {
    const r = nlToSteps(`Mở tab mới https://docs.example.com
Tải lại trang
Thấy "Welcome"`);
    expect(r.unparsed).toEqual([]);
    expect(r.steps.map((s) => s.type)).toEqual(["newTab", "reload", "assertVisible"]);
    assertAllValid(r.steps);
  });
});

describe("nl-to-steps unparsed honesty", () => {
  it("returns unparsed clauses explicitly instead of fabricating steps", () => {
    const r = nlToSteps(`open https://example.com
do something magical with quantum flux
click "OK"`);
    expect(r.steps.map((s) => s.type)).toEqual(["goto", "click"]);
    expect(r.unparsed).toEqual(["do something magical with quantum flux"]);
  });

  it("empty input yields empty output (no fabrication)", () => {
    expect(nlToSteps("")).toEqual({ steps: [], unparsed: [] });
    expect(nlToSteps("   \n  ").unparsed).toEqual([]);
  });
});
