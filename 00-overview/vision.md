# Vision

Playwright Studio is an authoring/orchestration layer for Playwright. Manual QA should automate common browser business flows without writing TypeScript; automation QA and developers must retain full Playwright power.

## Core loop
`Record → clean/edit steps → assertions → run → inspect failure → maintain`

## Product principles
1. **Upstream Playwright stays intact.** `@playwright/test` is the execution engine.
2. **JSON is source of truth.** Generated `.spec.ts` is a build artifact/export, not canonical storage.
3. **Progressive disclosure.** Tester sees business actions; developers can inspect locators/code/trace.
4. **Stable locators first.** Prefer role/label/test-id semantics over brittle CSS/XPath.
5. **Escape hatch always exists.** Unsupported flows can use developer-owned custom actions/code.
6. **Artifacts over mystery.** Every failure should expose error, screenshot and Playwright trace when available.
7. **Ship before enterprise.** P0 solves daily QA authoring and execution; governance/AI comes later.
