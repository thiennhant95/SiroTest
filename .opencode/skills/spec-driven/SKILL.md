# Skill: spec-driven Ã¢â‚¬â€ implement strictly by spec

> Executes the Playwright Studio spec in canonical order. Read `INDEX.md` first;
> spec folders `00-16` win over any summary when they conflict.

## 0. Boot: read the map

1. Read `INDEX.md`, then `README.md` (goal, non-goals, ship strategy).
2. Read `spec/16-decisions/architecture-decisions.md` (ADR-001Ã¢â‚¬Â¦ADR-006) Ã¢â‚¬â€ these are
   hard constraints, not suggestions.
3. Confirm P0 scope from `spec/00-overview/scope.md` and `spec/12-testing/test-strategy.md`
   Release gate before touching code.

## 1. Implementation order (per `README.md` Recommended order Ã¢â‚¬â€ mandatory)

Work strictly in this sequence; do not skip ahead to UI before the engine
layers below it are green:

1. `spec/03-test-model/` Ã¢â‚¬â€ versioned JSON `TestDefinition` (`schemaVersion: '1.0'`),
   step catalog, explicit migrations. Verify: schema validation/migration
   unit tests.
2. `spec/06-compiler/` Ã¢â‚¬â€ pure/deterministic JSON Ã¢â€ â€™ `@playwright/test` TypeScript;
   fixed locator mapping; `{{NAME}}` Ã¢â€ â€™ runtime env helper; secrets never
   inlined; unsupported step = explicit compile error. Verify: per-step-type
   unit tests + golden JSONÃ¢â€ â€™`.spec.ts` snapshots (generated code must
   parse/typecheck).
3. `spec/07-runner/` Ã¢â‚¬â€ validate Ã¢â€ â€™ resolve env/vars Ã¢â€ â€™ isolated temp run dir Ã¢â€ â€™
   compile Ã¢â€ â€™ execute with custom reporter Ã¢â€ â€™ stream WS Ã¢â€ â€™ persist Ã¢â€ â€™ cleanup.
   Verify: run-lifecycle integration test on the tiny fixture app; recovery
   test (interrupted runner).
4. `spec/05-locator/` Ã¢â‚¬â€ ranked candidates (`primary` + `alternatives`), P0 executes
   `primary` only; priority role Ã¢â€ â€™ label Ã¢â€ â€™ placeholder Ã¢â€ â€™ testId Ã¢â€ â€™ text Ã¢â€ â€™
   CSS Ã¢â€ â€™ XPath (uniqueness/stability modulate); 0 matches = unhealthy,
   N matches = warning. Verify: candidate-scoring + locatorÃ¢â€ â€™expression unit
   tests.
5. `spec/04-recorder/` Ã¢â‚¬â€ capture Ã¢â€ â€™ normalize/debounce Ã¢â€ â€™ definition; WS
   `recorder.*` events. Verify: recorder normalization unit tests +
   captureÃ¢â€ â€™definition integration test + session-recovery test.
6. `spec/08-api/` + `spec/09-database/` Ã¢â‚¬â€ CRUD/versioning, run endpoints, WS
   (`sessionId`/`runId` required; events informational, DB authoritative).
   Verify: API CRUD/versioning + WS ordering/state-recovery integration tests.
7. `spec/10-ui-ux/` Ã¢â‚¬â€ screens, visual builder, design system on top of the JSON
   model (never hand-edit generated code as source). Verify: Studio E2E
   (create project Ã¢â€ â€™ record fixture Ã¢â€ â€™ assert Ã¢â€ â€™ run Ã¢â€ â€™ PASS inspection).
8. `spec/12-testing/` Ã¢â‚¬â€ close the P0 release gate (see test-gate skill). Then, and
   only then, consider P1 (`spec/14-roadmap/roadmap.md`, `spec/15-tasks/p1-p2-backlog.md`).

Cross-cutting at every step: `spec/11-security/security.md` (redaction, encryption,
arg-array spawns, path-traversal protection, limits, auth) and
`spec/07-runner/artifacts-reporting.md` (artifact persistence).

## 2. Per-step verify loop (mandatory)

For EACH layer above, before moving to the next:

1. Implement the smallest spec-compliant increment.
2. Run `pnpm typecheck` (or affected package `typecheck`).
3. Run the corresponding test layer (see `test-gate` skill):
   model/compiler/locator Ã¢â€ â€™ `test:unit`; security surface Ã¢â€ â€™ `test:security`;
   API/runner/recorder Ã¢â€ â€™ `test:integration`; user flow Ã¢â€ â€™ `test:e2e`.
4. Fix failures without weakening spec constraints (no silent skips, no
   locator auto-switch, no secret inlining). Repeat until green.
5. Only then advance to the next layer.

## 3. Forbidden shortcuts

- No forking Playwright core (ADR-001); no TS-as-source round-tripping (ADR-002).
- No self-healing / locator fallback in P0 (ADR-003); no AI/nondeterminism
  in P0 (ADR-005).
- No custom-code steps in P0 while `ALLOW_CUSTOM_CODE` is unset (ADR-006).
- No P1/P2 scope (`spec/14-roadmap`, P1 backlog) while the P0 gate is red.
