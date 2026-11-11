# VietVang Test Web (SiroTest)

[![CI](https://github.com/thiennhant95/SiroTest/actions/workflows/ci.yml/badge.svg)](https://github.com/thiennhant95/SiroTest/actions/workflows/ci.yml)
![version](https://img.shields.io/badge/version-0.2.0-blue)
![node](https://img.shields.io/badge/node-20-green)
![playwright](https://img.shields.io/badge/playwright-1.63-45ba4b)

> Low-code E2E testing on top of upstream `@playwright/test`: testers **Record → Edit → Run** visually, developers keep native Playwright code, debugging and escape hatches. Never forks Playwright core.

**Live demo site:** https://thiennhant95.github.io/SiroTest/ (EN/VI/JA)

## Why teams switch

- 🎥 **Record, don't code** — click the real browser, steps appear with ranked locators.
- 🇻🇳 **Specs that execute** — Vietnamese `Cho rằng / Khi / Thì` Gherkin parses into runnable steps.
- 🤖 **Honest AI** — failure explanations, step drafting, smart naming; every answer badged `rules` or `llm`. Bring your own key or self-hosted gateway.
- 🧾 **Audit everything** — who did what, when. Undeletable, even project delete leaves a trace.
- 📦 **No lock-in** — one click exports standard Playwright specs + JUnit. Leave the tool, keep every test.
- 🏠 **Self-hosted** — one Windows/Linux host, SQLite single-file backup, no per-seat fees.

## Quickstart (5 minutes)

Prereqs: **Node 20** + **pnpm 9**.

```bash
git clone https://github.com/thiennhant95/SiroTest.git
cd SiroTest
pnpm install
pnpm db:generate
```

Windows (one double-click starter):

```powershell
powershell -ExecutionPolicy Bypass -File start-tool.ps1
```

Then open **http://127.0.0.1:5173** → Login page → **Dev** tab → `tester-1` → Record your first test → Run → green. See [Quickstart in /docs](./docs/remote-access-tailscale.md) for details, or press **Docs** inside the app.

Remote teammates (different networks): see [Remote access via Tailscale](./docs/remote-access-tailscale.md) — 15 minutes, no open router ports.

## Repo layout

| Path | What lives here |
|---|---|
| `apps/web` | React UI (Builder, runs, suites, AI tabs, Docs) |
| `apps/server` | Fastify API `/api/v1` + WS, scheduler, integrations (Jira/Backlog/Slack/Lark) |
| `apps/runner` | Deterministic compiler + isolated run execution |
| `apps/cli`, `apps/mcp` | CLI + MCP control-plane server |
| `packages/` | Test model, locator engine, recorder, compiler, AI helpers, action SDK |
| `e2e/`, `tests/` | Playwright E2E + integration suites |
| `prisma/` | SQLite schema (Postgres-compatible, no db-specific types) |
| `docs/` | Operator + user docs (also published as the demo site) |
| `00-16/` | Versioned engineering spec — source of truth, see `AGENTS.md` |
| `scripts/` | Ops helpers (retention cleanup, health check, member onboarding) |

## Quality gates (must stay green)

| Command | What it proves |
|---|---|
| `pnpm typecheck` | Whole monorepo compiles |
| `pnpm test:unit` | Model + compiler + locator units |
| `pnpm test:security` | SSRF guard, secret redaction, auth |
| `pnpm test:server-unit` | Server routes + AI wiring |
| `pnpm test:integration` | Full API/runner/recorder flows (185) |
| `pnpm test:e2e` | P0 Chromium flows (6) |
| `pnpm test:qc` | Tester-eyes UI regression (1) |

Release `v0.2.0` evidence is recorded in [CHANGELOG.md](./CHANGELOG.md).

## Free now, Pro later

The free version does real work (record, suites, Gherkin, audit, export, self-host).
Pro will add SSO, compliance exports, parallelism and SLA support. No license
file ships yet — one will be added before any public free announcement.

## Contributing

Read [AGENTS.md](./AGENTS.md) first (normative contributor rules), then the spec
folders in [INDEX.md](./INDEX.md). No P1/P2 work while the P0 release gate is red.
