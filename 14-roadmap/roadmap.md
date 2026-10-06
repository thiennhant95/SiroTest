# Roadmap

Status 2026-10-06: P0 and P1 fully shipped; P2 largely shipped (see item notes).

## P0 — usable MVP ✅ shipped
Core model/compiler/runner, recorder, locator picker, visual builder, assertions, environments/variables, run results/artifacts, code export, basic auth/roles/version history.

## P1 — team-ready ✅ shipped
Reusable business actions, test data/data-driven runs, suites/tags, auth/storage-state profiles, import/export, CI API/CLI, retries/parallel suites, scheduling, API/network actions, better report history. Plus: run-now, failure alerting, HMAC webhooks, Vietnamese Gherkin.

## P2 — differentiated product (partial)
Shipped: AI from natural language (rules; LLM with key), recorded-test cleanup, failure explanation, suggested assertions, explicit locator healing, plugin/action SDK, distributed workers, visual regression, RBAC/audit/retention, analytics/flaky.
Open: enterprise SSO live verification, healing DOM scoring, JUnit import, MCP server, Docker packaging, k6.

## Gate rule
Do not start P1 until a manual tester outside the implementation team can successfully create and maintain at least 5 representative business tests using P0.
