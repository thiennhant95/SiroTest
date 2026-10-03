# Deployment

## Local development
`pnpm install` → Prisma migrate → install Playwright browsers → `pnpm dev`.

## P0 self-host
Single Linux host/container group:
- web/server
- runner process
- SQLite volume
- artifact volume
- Playwright browser dependencies

Docker image should pin Node, Playwright package and matching browser image/dependencies.

## Configuration
`DATABASE_URL`, `STORAGE_PATH`, `APP_SECRET`, `SECRET_ENCRYPTION_KEY`, `MAX_CONCURRENT_RUNS`, `ARTIFACT_RETENTION_DAYS`, optional base URL/auth settings.

## Retention (artifacts + database)
Terminal runs older than `ARTIFACT_RETENTION_DAYS` (default 30, spec range
14–30) are reaped by two scripts — run both on the same schedule so disk
and DB agree (active `queued`/`running` rows are never touched):
- `pnpm cleanup` — removes `storage/runs/<run-id>/` dirs from disk.
- `pnpm cleanup:db` — removes the matching `Run` + `RunStep` + `Artifact`
  rows (`pnpm cleanup:db:dry` previews). Requires `DATABASE_URL`.

## CI
Lint + typecheck + unit + compiler golden tests + integration + Studio E2E fixture app. Do not download browsers repeatedly if CI cache/base image can pin them safely.
