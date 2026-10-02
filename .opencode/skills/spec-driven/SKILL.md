# Skill: spec-driven — implement strictly by spec

> Executes the Playwright Studio spec in canonical order. Read `INDEX.md` first;
> spec folders `00-16` win over any summary when they conflict.

## 0. Boot: read the map

1. Read `INDEX.md`, then `README.md` (goal, non-goals, ship strategy).
2. Read `16-decisions/architecture-decisions.md` (ADR-001…ADR-006) — these are
   hard constraints, not suggestions.
3. Confirm P0 scope from `00-overview/scope.md` and `12-testing/test-strategy.md`
   Release gate before touching code.

## 1. Implementation order (per `README.md` Recommended order — mandatory)

Work strictly in this sequence; do not skip ahead to UI before the engine
layers below it are green:

1. `03-test-model/` — versioned JSON `TestDefinition` (`schemaVersion: '1.0'`),
   step catalog, explicit migrations. Verify: schema validation/migration
   unit tests.
2. `06-compiler/` — pure/deterministic JSON → `@playwright/test` TypeScript;
   fixed locator mapping; `{{NAME}}` → runtime env helper; secrets never
   inlined; unsupported step = explicit compile error. Verify: per-step-type
   unit tests + golden JSON→`.spec.ts` snapshots (generated code must
   parse/typecheck).
3. `07-runner/` — validate → resolve env/vars → isolated temp run dir →
   compile → execute with custom reporter → stream WS → persist → cleanup.
   Verify: run-lifecycle integration test on the tiny fixture app; recovery
   test (interrupted runner).
4. `05-locator/` — ranked candidates (`primary` + `alternatives`), P0 executes
   `primary` only; priority role → label → placeholder → testId → text →
   CSS → XPath (uniqueness/stability modulate); 0 matches = unhealthy,
   N matches = warning. Verify: candidate-scoring + locator→expression unit
   tests.
5. `04-recorder/` — capture → normalize/debounce → definition; WS
   `recorder.*` events. Verify: recorder normalization unit tests +
   capture→definition integration test + session-recovery test.
6. `08-api/` + `09-database/` — CRUD/versioning, run endpoints, WS
   (`sessionId`/`runId` required; events informational, DB authoritative).
   Verify: API CRUD/versioning + WS ordering/state-recovery integration tests.
7. `10-ui-ux/` — screens, visual builder, design system on top of the JSON
   model (never hand-edit generated code as source). Verify: Studio E2E
   (create project → record fixture → assert → run → PASS inspection).
8. `12-testing/` — close the P0 release gate (see test-gate skill). Then, and
   only then, consider P1 (`14-roadmap/roadmap.md`, `15-tasks/p1-p2-backlog.md`).

Cross-cutting at every step: `11-security/security.md` (redaction, encryption,
arg-array spawns, path-traversal protection, limits, auth) and
`07-runner/artifacts-reporting.md` (artifact persistence).

## 2. Per-step verify loop (mandatory)

For EACH layer above, before moving to the next:

1. Implement the smallest spec-compliant increment.
2. Run `pnpm typecheck` (or affected package `typecheck`).
3. Run the corresponding test layer (see `test-gate` skill):
   model/compiler/locator → `test:unit`; security surface → `test:security`;
   API/runner/recorder → `test:integration`; user flow → `test:e2e`.
4. Fix failures without weakening spec constraints (no silent skips, no
   locator auto-switch, no secret inlining). Repeat until green.
5. Only then advance to the next layer.

## 3. Forbidden shortcuts

- No forking Playwright core (ADR-001); no TS-as-source round-tripping (ADR-002).
- No self-healing / locator fallback in P0 (ADR-003); no AI/nondeterminism
  in P0 (ADR-005).
- No custom-code steps in P0 while `ALLOW_CUSTOM_CODE` is unset (ADR-006).
- No P1/P2 scope (`14-roadmap`, P1 backlog) while the P0 gate is red.
