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

## Production hardening P1
Containerized workers, egress policy, per-project secret encryption, audit logs, SSO/RBAC, rate limits and signed artifact access.

## Self-host operations (P0 implementation notes)
- `SECRET_ENCRYPTION_KEY` (fallback `SERVER_SECRET_KEY`): base64 of 32 random bytes for AES-256-GCM secret-at-rest encryption (`apps/server/src/security.ts`). Without it, secrets store legacy-plaintext (dev only). Back it up — losing it orphans encrypted rows.
- `ALLOW_PRIVATE_TARGETS=1`: permits loopback/private run targets for local E2E against the bundled `/fixture` app. NEVER enable on internet-facing hosts (SSRF).
- `ALLOW_CUSTOM_CODE` stays unset: arbitrary custom steps are rejected for ALL roles (step allowlist in `security.ts` + runner `validate.ts` + both compilers).
- Limits: JSON body 1 MB, test definition 512 KB, single artifact 50 MB (`ARTIFACT_MAX_BYTES`), 100 screenshots/run.
- Auth: REST requires `Authorization: Bearer` (or dev `x-user-id`); WS `/ws` requires `?token=` and fans events out only to the subscribed `runId`/`sessionId`. No cookie auth exists, so there is no cookie-CSRF surface; do not add cookie sessions without Origin-checked CSRF tokens.
- Tests: `apps/server/src/security.test.ts`, `apps/runner/src/runner-security.test.ts` (both `tsx --test`), `packages/playwright-compiler/tests/security.test.ts` (`node --test` after build).
