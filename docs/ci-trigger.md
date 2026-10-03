# CI trigger & scheduling

Two P1 mechanisms run Studio tests from CI / external schedulers. Both reuse
the server as the only execution path — no engine fork (ADR-001), no custom
code over the wire.

## 1. `studio` CLI (CI trigger)

`apps/cli` (`@playwright-studio/cli`) calls the existing REST surface over
HTTP: `POST /api/v1/tests/:id/runs`, `POST /api/v1/suites/:sid/runs`,
`GET /api/v1/runs/:id`, `GET /api/v1/suite-runs/:id`, plus the
spec/JUnit export endpoints. Auth is the standard REST contract
(`Authorization: Bearer <token>`); the CLI never prints the token.

### GitHub Actions — suite gate (fail-fast + JUnit artifact)

```yaml
name: nightly-suite
on:
  schedule:
    - cron: '0 17 * * *' # 00:00 ICT
  workflow_dispatch:

jobs:
  studio-suite:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9.0.0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }

      - run: pnpm install --frozen-lockfile

      - name: Run suite (fail-fast on non-pass)
        env:
          STUDIO_API_URL: ${{ secrets.STUDIO_API_URL }} # e.g. https://studio.example.com
          STUDIO_TOKEN: ${{ secrets.STUDIO_TOKEN }}
        run: >
          pnpm studio suite-run
          --suite ${{ vars.STUDIO_SUITE_ID }}
          --env ${{ vars.STUDIO_ENV_ID }}
          --retries 1 --parallel 2 --wait
          --timeout-ms 1500000 --interval-ms 5000

      - name: Export JUnit (always, for the report)
        if: always()
        env:
          STUDIO_API_URL: ${{ secrets.STUDIO_API_URL }}
          STUDIO_TOKEN: ${{ secrets.STUDIO_TOKEN }}
        run: >
          pnpm studio export
          --suite-run ${{ steps.run.outputs.suite-run-id }}
          -o studio-junit.xml
        # Tip: with --wait the suite step above already fails the job on a
        # red suite; keep this export step `if: always()` so the report lands
        # even then. (If you need the id programmatically, run the non-wait
        # form first, capture its `suite-run <id>` line, then poll with --wait.)

      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: studio-junit, path: studio-junit.xml }
```

Single-test gate variant:

```yaml
      - name: Run one test
        env:
          STUDIO_API_URL: ${{ secrets.STUDIO_API_URL }}
          STUDIO_TOKEN: ${{ secrets.STUDIO_TOKEN }}
        run: pnpm studio run --test <testId> --env <envId> --wait
```

### Environment variables

| Variable | Used by | Meaning |
| -------- | ------- | ------- |
| `STUDIO_API_URL` | `run`, `suite-run`, `export` | Default for `--api` |
| `STUDIO_TOKEN` | `run`, `suite-run`, `export` | Default for `--token` (a secret — CI `secrets`, never `vars`) |
| `DATABASE_URL` | `trigger-schedules --once` | Server DB (same value the server uses) |
| `STUDIO_SERVER_DIST` | `trigger-schedules --once` | Alt compiled-server dir (default `apps/server/dist`) |

### Exit codes

| Code | Meaning | CI effect |
| ---- | ------- | --------- |
| 0 | passed (or accepted/written without `--wait`) | step passes |
| 1 | failed — or the CLI/API call itself errored (4xx/5xx, network) | step fails |
| 2 | cancelled | step fails (distinguishable from 1 in `if:` conditions) |
| 3 | `--wait` timed out before the run settled | step fails — raise `--timeout-ms` or check the server queue |
| 64 | usage/config error (bad flags, missing token/`DATABASE_URL`) | step fails — fix the workflow |

`--timeout-ms` defaults to 600 000 (10 min), `0` disables the deadline;
`--interval-ms` defaults to 2000 (min 100).

## 2. Scheduling

Schedules live in the `Schedule` table
(`{ projectId, suiteId?, testId?, environmentId, cron, enabled, retries,
lastRunAt, nextRunAt, createdBy }`, cron = 5-field `minute hour dom month
dow`). A suite schedule fires all members at once through the existing
`runQueue(2)` (queue caps real concurrency, `retries` reuse the suite retry
orchestration); a test schedule mirrors `POST /tests/:id/runs`
(`trigger: 'schedule'`). Both default to `chromium` headless in P1 (the
table carries no browser/headed columns yet).

### In-process ticker (default)

The server starts `startScheduler()` at boot (`apps/server/src/index.ts`
and the `app.ts` dev-listen block). One pass per `SCHEDULER_INTERVAL_MS`
(default 60 000, min 5000):

- only `enabled` schedules whose cron matches the current minute and whose
  `lastRunAt` is older than this minute are due;
- a schedule whose suite/test already has a `queued`/`running` run is
  **skipped** (overlap guard — `nextRunAt` still advances);
- each schedule fires inside its own try/catch: one bad schedule (invalid
  cron, missing suite/env, rejected target URL) is logged and counted, never
  crashes the ticker;
- `lastRunAt`/`nextRunAt` are persisted per fire/skip; WS remains
  informational, the DB authoritative.

Guards: the ticker never starts when `SKIP_LISTEN=1` (tests, e2e hosts);
`SCHEDULER_DISABLED=1` opts a host out of the in-process ticker entirely.
Run a single server instance per database (documented single-host P1 scope).

### External cron (`trigger-schedules --once`)

For hosts where the in-process ticker is disabled, drive the same
`runDueSchedulesOnce` pass from outside — e.g. Windows Task Scheduler every
minute (see `SELFHOST-WINDOWS.md` patterns):

```powershell
$env:DATABASE_URL = (Get-Content C:\studio\db-url.txt -Raw).Trim()
pnpm studio trigger-schedules --once
```

It prints `checked/due/fired/skipped/failed` and exits 1 when any schedule
failed. Cron syntax supported: `*`, ranges (`1-5`), steps (`*/15`,
`1-10/2`), lists (`0,30`), numeric only, `dow` 0–6 (`7` = Sunday alias);
`dom`+`dow` both restricted ⇒ either matches (Vixie). Times use the server's
local timezone.
