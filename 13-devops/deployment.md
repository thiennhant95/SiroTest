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

## CI
Lint + typecheck + unit + compiler golden tests + integration + Studio E2E fixture app. Do not download browsers repeatedly if CI cache/base image can pin them safely.
