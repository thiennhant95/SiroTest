# P0 Task Breakdown — Ship Fast

## Day 1 — foundation
- Monorepo, web/server/packages
- Prisma SQLite
- test-model schema + validation
- sample fixture web app
- compiler skeleton

**Gate:** JSON login fixture compiles to valid Playwright test.

## Day 2 — compiler + runner
- Implement P0 step mappings
- variable resolver/redaction
- isolated run workspace
- custom reporter + persisted result
- screenshot/trace

**Gate:** API-triggered JSON test runs and returns deterministic result.

## Day 3 — locator engine
- semantic candidate generation
- scoring/uniqueness
- locator picker protocol
- test/highlight locator

**Gate:** common form/button elements resolve to stable locators.

## Day 4 — recorder
- session manager
- browser launch
- event capture
- fill debounce/normalization
- WS step streaming

**Gate:** login flow records into clean JSON.

## Day 5 — builder UI
- test list/builder
- step cards/inspector
- add/edit/delete/reorder/disable
- locator editor/picker integration

**Gate:** tester can edit recorded flow without JSON/code.

## Day 6 — assertions + variables
- assertion picker
- environments
- variables/secrets
- run controls/live progress

**Gate:** staging login test with secret credentials passes.

## Day 7 — results/code/history
- run detail
- screenshot/trace links
- code tab/export
- test version history/restore
- polish error/empty/loading states

## Days 8–10 — stabilization buffer
- E2E Studio tests
- security/redaction
- interrupted processes
- Docker/self-host docs
- pilot with real tester
- fix P0 blockers only

## Freeze rule
After pilot begins, no P1 feature is accepted until P0 acceptance criteria pass.
