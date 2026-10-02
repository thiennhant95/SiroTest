# Skill: test-gate — P0 release test gate

> Runs the P0 gate from `package.json` scripts + `12-testing/test-strategy.md`.
> Fix failures without weakening spec constraints (see `AGENTS.md`);
> after every fix re-run typecheck + the affected layer.

## 1. Commands (canonical, from root `package.json`)

| Layer       | Command                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | `pnpm test:unit` (= test-model + playwright-compiler + locator-engine filters)                                                                                      |
| security    | `pnpm test:security` (`tsx --test apps/server/src/security.test.ts apps/runner/src/runner-security.test.ts`)                                                        |
| integration | `pnpm test:integration` (`tsx --test tests/integration/recorder.test.ts tests/integration/compiler-p0.test.ts tests/integration/run-lifecycle.test.ts tests/integration/api-crud-versioning.test.ts`) |
| e2e         | `pnpm test:e2e` (`playwright test -c e2e/playwright.config.ts`, Chromium)                                                                                           |
| full P0     | `pnpm test:p0` (= unit → security → integration → e2e in sequence)                                                                                                   |

Plus after every change: `pnpm typecheck` (or affected package `typecheck`).

## 2. Pass criteria (P0 gate is green iff ALL hold)

- `test:unit`: all suites pass — test-model 6/6, playwright-compiler 55/55,
  locator-engine 26/26.
- `test:security`: 28/28 — at-rest encryption/redaction, no secret in
  generated code/logs/WS/result JSON, arg-array spawns, path-traversal
  protection, custom-code rejection, limits, auth.
- `test:integration`: 47/47 — recorder capture→definition, compiler P0,
  run lifecycle on fixture app, API CRUD/versioning, artifact persistence,
  WS ordering/state recovery.
- `test:e2e`: core Studio flow green on Chromium — create project → record
  fixture app → add assertion → run → PASS, then intentional failure →
  screenshot/trace available.
- Secret-redaction tests green; interrupted runner/recorder recovery tested
  (`apps/runner/tests/recovery.test.mjs`,
  `packages/recorder/tests/session-recovery.test.mjs`).
- Golden compiler fixtures: every P0 step type has JSON→`.spec.ts` snapshot
  coverage and generated code parses/typechecks.
- No known data-loss bug open (`12-testing/test-strategy.md` Release gate).

## 3. Procedure

1. Run `pnpm typecheck`.
2. Run layers bottom-up: `test:unit` → `test:security` → `test:integration`
   → `test:e2e` (or `pnpm test:p0` for the full gate).
3. On failure: locate the spec section (`03/05/06/07/08/11/12`), fix the code
   (never the test expectation, unless the test itself contradicts the spec —
   then fix the test and note the spec reference), re-run typecheck + the
   failed layer, then re-run the full `test:p0` before declaring green.
4. Report per-layer counts (e.g. `unit 6/6+55/55+26/26, security 28/28,
   integration 47/47, e2e PASS-Chromium`) plus typecheck status.

## 4. Notes

- Security suites run via `tsx --test`; compiler security tests via
  `node --test` after build (`packages/playwright-compiler/tests/security.test.ts`).
- `ALLOW_PRIVATE_TARGETS=1` is for local E2E against the bundled `/fixture`
  app only — never on internet-facing hosts (SSRF, `11-security`).
- Do not open P1 work while any criterion above is red (`AGENTS.md` §9).
