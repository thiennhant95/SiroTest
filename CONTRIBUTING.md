# Contributing to SiroTest

Thanks for helping. This repo is spec-driven: the JSON `TestDefinition` is the
source of truth and generated Playwright code is output only.

## Before you start

1. Read [AGENTS.md](./AGENTS.md) — normative rules (no Playwright fork, no silent
   skips, no secret inlining, deterministic compiler).
2. Skim [INDEX.md](./INDEX.md) → `spec/` folders for the area you touch.
3. No P1/P2 work while the P0 release gate is red.

## Setup

```bash
git clone https://github.com/thiennhant95/SiroTest.git
cd SiroTest
pnpm install
pnpm db:generate
```

Run it:

```powershell
powershell -ExecutionPolicy Bypass -File start-tool.ps1
```

## Before opening a PR

Run the gates that cover your change:

```bash
pnpm typecheck
pnpm test:unit          # model + compiler + locator
pnpm test:security      # SSRF, redaction, auth
pnpm test:server-unit   # routes + AI wiring
pnpm test:integration   # API/runner/recorder flows
pnpm test:e2e           # Chromium P0 flows
```

Compiler changes must keep golden snapshots byte-identical and the generated
code must parse/typecheck.

## Style

- TypeScript strict, no `any` unless justified at the boundary.
- Never log secrets, tokens or absolute server paths.
- Comments explain *why*, not *what*.
- Small, focused commits with a clear subject line.

## Reporting bugs

Use the issue template. Include: version (`package.json`), OS, what you expected,
what happened, and the run ID if the bug is in a test run.

## Security issues

Do **not** open a public issue. See [SECURITY.md](./SECURITY.md).
