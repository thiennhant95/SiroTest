# Playwright Studio — Engineering Specification

> No-code / low-code authoring layer on top of upstream `@playwright/test`.

## Goal
Allow manual testers to Record → Edit visual steps → Add assertions → Run → Inspect artifacts, while developers retain native Playwright code, debugging and escape hatches.

## Non-goals
- Do not fork or modify Playwright core.
- Do not build a new browser automation engine.
- Do not put AI/self-healing in P0.
- Do not attempt to support every Playwright API through the visual builder.

## Ship strategy
- **P0 / MVP:** 7–10 dev-days target: project/test CRUD, recorder, visual editor, locator picker, assertions, variables/environments, runner, results/artifacts, code generation.
- **P1:** reusable actions, data-driven tests, suites/tags, import/export, scheduling/CI, stronger collaboration.
- **P2:** AI assistance, self-healing, plugins, distributed runners, enterprise governance.

## Recommended implementation order
1. `03-test-model/`
2. `06-compiler/`
3. `07-runner/`
4. `05-locator/`
5. `04-recorder/`
6. `08-api/` + `09-database/`
7. `10-ui-ux/`
8. `12-testing/`
9. P1/P2 only after MVP acceptance gate.

## Documents
See [INDEX.md](./INDEX.md) for the full map.
