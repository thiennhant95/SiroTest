# AGENTS.md — Mandatory rules for every agent (Playwright Studio / playwright-vv)

> Source of truth: `INDEX.md` + spec folders `00-16`. This file is a normative
> summary — when in doubt, the spec folder wins. No P1/P2 work until the P0
> release gate is green.

## 1. Canonical model & engine boundaries (ADR-001, ADR-002)

- Versioned JSON `TestDefinition` (`03-test-model/test-definition.md`,
  `schemaVersion: '1.0'`) is the ONLY source of truth. Visual editor and
  compiler operate on JSON; generated TypeScript is output only.
- NEVER fork or modify Playwright core. Upstream `@playwright/test` remains
  the execution engine (`README.md` non-goals, ADR-001).
- NEVER silently mutate stored definitions. `schemaVersion` migrations must be
  explicit, deterministic and tested (`03-test-model` Compatibility).

## 2. Compiler is deterministic and pure (`06-compiler/playwright-compiler.md`)

- Same definition + same compiler version ⇒ byte-identical output.
- Escape all generated strings safely; generated export must be readable,
  not minified; preserve step names via `test.step()` when useful.
- Locator mapping is fixed:
  `role` → `page.getByRole()`; `label` → `getByLabel()`;
  `placeholder` → `getByPlaceholder()`; `testId` → `getByTestId()`;
  `text` → `getByText()`; `css`/`xpath` → `page.locator()`.
- `{{NAME}}` variables compile to an injected runtime env/config helper.

## 3. P0 executes primary locator ONLY — no self-healing (ADR-003, `05-locator`)

- Recorder stores ranked candidates (`primary` + `alternatives`), but P0
  executes `primary` only. Alternatives are evidence for future (P2) repair.
- NEVER silently switch locator during execution. P2 healing must be
  explicit/auditable — it is out of scope for P0 (`README.md`, ADR-005).
- Locator priority (not absolute — candidates must also be unique and stable):
  1. Role + accessible name
  2. Label
  3. Placeholder
  4. Test ID
  5. Stable text
  6. Stable CSS
  7. XPath fallback
- A step cannot be saved as healthy when its locator matches 0; N matches
  show a warning unless the action/assertion permits multiple.

## 4. Secrets (`06-compiler`, `11-security/security.md`)

- NEVER inline secret values into generated code, logs, WS events or result JSON.
- Secret values resolve at run time and are redacted everywhere.
- Never return plaintext secrets from normal read APIs after creation.
- `SECRET_ENCRYPTION_KEY` (fallback `SERVER_SECRET_KEY`) = base64 of 32 random
  bytes for AES-256-GCM at-rest encryption (`apps/server/src/security.ts`).
  Without it, storage is legacy-plaintext (dev only).
- NEVER concatenate user input into shell commands. Spawn Playwright/Node with
  argument arrays only.

## 5. No silent skips, no silent failures

- Unsupported step ⇒ compilation FAILS with an explicit error. Never silently
  skip (`06-compiler` Requirements).
- Runner lifecycle is fixed (`07-runner/runner-spec.md`): validate → resolve
  env/variables → isolated temp run dir → compile spec/config → execute with
  custom reporter → stream WS events → persist
  status/duration/error/artifact metadata → cleanup temp source, retain
  configured artifacts.
- Run status: `queued | running | passed | failed | cancelled`.
  Step status: `pending | running | passed | failed | skipped`.
- Cancellation must kill the child Playwright process tree and mark incomplete
  step/run `cancelled`.

## 6. State authority: WS is informational, DB is authoritative

- WS payloads require `sessionId` or `runId`
  (`08-api/websocket-events.md`: recorder.* + run.* / step.* events).
- Events are informational ONLY. On reconnect the client must fetch current
  run/session state from the DB/API instead of assuming no events were missed.

## 7. Isolation & execution safety (`07-runner`, `11-security`)

- Each run gets a UNIQUE working directory + UNIQUE browser context, used
  ONCE. Never reuse test state unless an explicit P1 auth/storage-state
  feature is used.
- P0 default 1–2 concurrent runs per host (configurable); queue excess; never
  let recorder sessions starve execution workers.
- Timeout precedence: project default → test override → step override; UI must
  make overrides visible.
- Run executions in dedicated working dirs with path-traversal protection;
  validate URLs + project permissions before recorder/run; artifact/size
  limits apply (JSON body 1 MB, definition 512 KB, single artifact 50 MB,
  100 screenshots/run); never expose server filesystem paths to browser clients.
- `ALLOW_CUSTOM_CODE` stays unset in P0: arbitrary custom steps are rejected
  for ALL roles (ADR-006 — custom code is a Developer/Admin escape hatch, not
  normal tester UX; preferably disabled in P0 without a safe sandbox).
- `ALLOW_PRIVATE_TARGETS=1` only for local E2E against the bundled `/fixture`
  app. NEVER on internet-facing hosts (SSRF).
- Auth: REST requires `Authorization: Bearer` (or dev `x-user-id`); WS `/ws`
  requires `?token=` and fans out only to the subscribed `runId`/`sessionId`.
  No cookie auth exists — do not add cookie sessions without Origin-checked
  CSRF tokens.

## 8. After every fix: typecheck + corresponding tests

- Run `pnpm typecheck` (or the affected package `typecheck`) plus the test
  layer(s) covering the change — see `.opencode/skills/test-gate/SKILL.md`:
  `pnpm test:unit | test:security | test:integration | test:e2e | test:p0`.
- Golden compiler rule (`12-testing/test-strategy.md`): JSON fixtures with
  expected `.spec.ts` snapshots; generated code must also parse/typecheck.

## 9. P0 gate first — no P1 until green

- Do NOT open P1 work (reusable actions, data-driven tests, suites/tags,
  import/export, scheduling/CI, collaboration) while the P0 gate
  (`12-testing` Release gate: no known data-loss bug; compiler coverage for
  every P0 step; core E2E green on Chromium; secret redaction green;
  interrupted runner/recorder recovery tested) is red.
- P2 (AI assistance, self-healing, plugins, distributed runners, enterprise
  governance) is never a substitute for a red P0.
