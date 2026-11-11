# Security Specification

Browser automation can execute untrusted web content; treat recorder/runner as privileged infrastructure.

## P0 requirements
- Encrypt secret variables at rest when a server key is configured; never return plaintext secrets to normal read APIs after creation.
- Redact secrets from logs, generated code, WS events and result JSON.
- Validate URLs and project permissions before starting recorder/run.
- Do not concatenate user input into shell commands. Spawn Playwright/Node with argument arrays.
- Run executions in dedicated working directories with path traversal protection.
- Restrict custom code to Developer/Admin; preferably disable arbitrary custom code in P0 if safe sandboxing is not ready.
- Apply upload/artifact size limits.
- Protect API/WS with authenticated sessions/tokens.
- CSRF protection where cookie auth is used.
- Never expose server filesystem paths directly to browser clients.

## Enforced RBAC + operational guards (P2 implementation notes)
- Gates (`apps/server/src/rbac.ts`, `auth.ts`): `requireProjectWrite` / `requireWriteAccessToProject` on every mutating project route — global `admin` bypasses (owner-equivalent); global `viewer` is read-only everywhere (403 even with a member row); project `viewer`/non-member gets explicit 403 on writes; reads unchanged. `requireRole(projectId, minRole)` for project-scoped P2 routes: viewer reads, editor+ writes, owner for destructive actions. `requireGlobalWriter` (admin/developer/tester) for non-project writes. `requirePrivileged` (admin/developer only) for plugin reload.
- Matrix (✓ = allowed; project capabilities require membership):

| actor | read (member) | project write | delete project | approve/reject healing | plugins reload | workers register/sweep/board |
| global admin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| project owner | ✓ | ✓ | ✓ | ✓ | —* | —* |
| project editor | ✓ | ✓ | — | ✓ | —* | —* |
| project viewer / global viewer | ✓ | — | — | — | — | — |

  \* plugins reload and workers ops are global-role gates, not project roles: reload needs global admin/developer + `ALLOW_PLUGINS=1`; workers register/list/sweep/deregister need a global writer (admin/developer/tester). Worker heartbeat/complete are authenticated protocol endpoints (ownership-checked), not role-gated.
- Route wiring (spot-verified): `POST /projects` global-writer (creator becomes owner); `PATCH /projects/:id` editor+; `DELETE /projects/:id` owner. `tests.ts` mutating routes + `POST /projects/:projectId/variables` use `requireProjectWrite`; by-id `PATCH/DELETE /variables/:id` resolve the owning project first, then `requireWriteAccessToProject`. Healing approve/reject require editor+.
- Delete-under-live-run guard: `assertNoActiveRuns` (`rbac.ts`) — test, environment and project deletes fail with `CONFLICT_ACTIVE_RUNS` 409 while queued/running runs exist (suite delete checks each member). Cancel the runs first — explicit, never silent (cascade would crash the live worker).
- Webhook receivers: outbound `webhook` integrations POST JSON with `X-VV-Event: <event>` and, only when a `signingSecret` is configured, `X-VV-Signature: v1=<hex HMAC-SHA256 of the raw body>` (`integrations.ts`). Receivers must recompute the HMAC over the raw body bytes with the shared secret (constant-time compare); a missing header means unsigned — do not trust. Delivery is fire-and-forget and never fails the run.
- Server-path non-disclosure: `GET /plugins` exposes `dirName: basename(dir)` only — absolute server paths never leave the server.

## Production hardening P1
Containerized workers, egress policy, per-project secret encryption, audit logs, SSO/RBAC, rate limits and signed artifact access.

## Self-host operations (P0 implementation notes)
- `SECRET_ENCRYPTION_KEY` (fallback `SERVER_SECRET_KEY`): base64 of 32 random bytes for AES-256-GCM secret-at-rest encryption (`apps/server/src/security.ts`). Without it, secrets store legacy-plaintext (dev only). Back it up — losing it orphans encrypted rows.
- `ALLOW_PRIVATE_TARGETS=1`: permits loopback/private run targets for local E2E against the bundled `/fixture` app. NEVER enable on internet-facing hosts (SSRF).
- `ALLOW_CUSTOM_CODE` stays unset: arbitrary custom steps are rejected for ALL roles (step allowlist in `security.ts` + runner `validate.ts` + both compilers).
- Limits: JSON body 1 MB, test definition 512 KB, single artifact 50 MB (`ARTIFACT_MAX_BYTES`), 100 screenshots/run.
- Auth: REST requires `Authorization: Bearer` (or dev `x-user-id`); WS `/ws` requires `?token=` and fans events out only to the subscribed `runId`/`sessionId`. No cookie auth exists, so there is no cookie-CSRF surface; do not add cookie sessions without Origin-checked CSRF tokens.
- Tests: `apps/server/src/security.test.ts`, `apps/runner/src/runner-security.test.ts` (both `tsx --test`), `packages/playwright-compiler/tests/security.test.ts` (`node --test` after build).
