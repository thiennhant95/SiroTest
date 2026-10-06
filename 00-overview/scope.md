# Scope

Status 2026-10-06: P0 gate green, P1 shipped, P2 partially shipped (see below).
The non-goals below are historical P0 boundaries — several have since shipped
as P1/P2 and are marked.

## P0 — ship ✅
- Projects and tests CRUD
- Browser recorder
- Visual step list/editor
- Locator picker and locator testing
- ~25 common browser actions/assertions
- Project/environment variables and secrets
- Chromium execution; Firefox/WebKit if zero extra complexity
- Live run progress
- Screenshot/video/trace/result artifacts
- Generated Playwright code view/export
- Basic roles: Admin, Developer, Tester (+ Viewer read-only since P2 RBAC)
- Test definition version history

## Explicit P0 non-goals (historical — do not read as current gaps)
- ~~AI generation/self-healing~~ → shipped P2 (rules-based compose/Gherkin/explain; proposal-only healing)
- Full test management product
- Distributed runner farm (workers exist; farm orchestration open)
- ~~Visual regression platform~~ → shipped P2 (baselines + compare)
- Native mobile
- Performance/load testing
- Every Playwright API
- ~~Complex RBAC/SSO/audit compliance~~ → RBAC + audit shipped P2 (OIDC config-only, IdP unverified)

## P1 ✅ shipped
Reusable actions, test data sets, suites/tags, import/export, CI command/API, scheduling, retries, parallel suite runs, storage state/auth profiles, network/API steps. Plus: run-now, failure alerting (Slack/Lark), generic HMAC webhooks, Vietnamese Gherkin tab.

## P2 (partial)
Shipped: AI authoring/failure explanation (rules; LLM only with key), locator healing (verified proposals), plugin SDK, distributed workers, RBAC/audit, visual regression, analytics/flaky.
Open: OIDC live verification, healing DOM scoring, JUnit import, MCP server, Docker packaging, k6.
