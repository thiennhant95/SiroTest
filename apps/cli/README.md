# @playwright-studio/cli — `studio`

CI trigger for Playwright Studio. It calls the **server HTTP API directly**
and never runs tests locally: the Playwright engine stays server-side
(ADR-001 — no engine fork, no custom code over the wire).

## Install

From the repo root (workspace link, no publish needed):

```powershell
pnpm install
pnpm studio --help
```

`pnpm studio` runs `tsx apps/cli/src/studio.ts`. For a standalone binary,
`pnpm --filter @playwright-studio/cli build` then `node apps/cli/dist/studio.js`.

## Commands

```powershell
# Start one test run (prints the run id, exits 0)
studio run --api http://127.0.0.1:3001 --token $env:STUDIO_TOKEN --test <testId> --env <envId>

# Same, but wait for the terminal status (exit 0/1/2, 3 on timeout)
studio run --api http://127.0.0.1:3001 --token $env:STUDIO_TOKEN --test <testId> --env <envId> --wait

# Suite execution (parallel 1|2, retries 0..5)
studio suite-run --api http://127.0.0.1:3001 --token $env:STUDIO_TOKEN --suite <suiteId> --env <envId> --wait

# Exports (spec for tests, JUnit for runs / suite-runs)
studio export --api http://127.0.0.1:3001 --token $env:STUDIO_TOKEN --test <testId> -o login.spec.ts
studio export --api http://127.0.0.1:3001 --token $env:STUDIO_TOKEN --run <runId> -o junit.xml
studio export --api http://127.0.0.1:3001 --token $env:STUDIO_TOKEN --suite-run <suiteRunId> -o suite.xml

# Fire all due schedules once (external cron mode — run ON the server host)
studio trigger-schedules --once
```

`--api`/`--token` fall back to `STUDIO_API_URL` / `STUDIO_TOKEN`. The token
is only ever sent as an `Authorization: Bearer` header — never printed,
never in URLs or files (covered by unit tests).

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | passed (or accepted/written for non-`--wait` commands) |
| 1 | failed — or the CLI/API call itself errored |
| 2 | cancelled |
| 3 | `--wait` timed out (`--timeout-ms`, default 10 min, `0` = none) |
| 64 | usage/config error (bad flags, missing token, missing `DATABASE_URL`) |

## `trigger-schedules --once`

Local-mode command for external schedulers (Windows Task Scheduler / cron)
when the server runs with `SCHEDULER_DISABLED=1`. It must run **on the server
host** with the server's `DATABASE_URL`, dynamically loads the built server
scheduler (`apps/server/dist/scheduler.js` — run
`pnpm --filter @vv/server build` first, or pass `--server-dist` /
`STUDIO_SERVER_DIST`), and performs one `runDueSchedulesOnce` pass with the
same guards as the in-process ticker (per-minute dedupe, overlap skip,
per-schedule error isolation). Prints
`checked/due/fired/skipped/failed` and exits 1 when any schedule failed.

## Development

- Manual argv parsing (no `commander` — kept dependency-free, Node built-ins only).
- Tests: `pnpm --filter @playwright-studio/cli test`
  (`args` parsing, API client with mock fetch, command flows incl. exit codes
  and token-leak assertions).
- See `docs/ci-trigger.md` for the GitHub Actions pattern.
