# REST API Specification

Prefix: `/api/v1`.

## Projects
`GET /projects`
`POST /projects`
`GET /projects/:id`
`PATCH /projects/:id`
`DELETE /projects/:id`

## Tests
`GET /projects/:projectId/tests`
`POST /projects/:projectId/tests`
`GET /tests/:id`
`PATCH /tests/:id`
`DELETE /tests/:id`
`POST /tests/:id/duplicate`
`GET /tests/:id/versions`
`POST /tests/:id/versions/:versionId/restore`

## Environments
`GET /projects/:projectId/environments`
`POST /projects/:projectId/environments`
`PATCH /environments/:id`
`DELETE /environments/:id`

## Recorder
`POST /tests/:id/recorder/start`
`POST /recorder/:sessionId/pause`
`POST /recorder/:sessionId/resume`
`POST /recorder/:sessionId/stop`
`POST /recorder/:sessionId/locator/test`

## Runs
`POST /tests/:id/runs`
`GET /runs/:id`
`POST /runs/:id/cancel`
`GET /tests/:id/runs`

Example run request:
```json
{"environmentId":"env_staging","browser":"chromium","headed":false}
```

## Compiler/export
`POST /tests/:id/compile`
`GET /tests/:id/export?format=spec`

## Schedules
`GET /projects/:projectId/schedules`
`POST /projects/:projectId/schedules` → `201` created Schedule
`GET /schedules/:sid` → `404 NOT_FOUND` when unknown
`PATCH /schedules/:sid`
`DELETE /schedules/:sid` → `204`
`GET /schedules/:sid/runs` (history: `trigger='schedule'` runs for this target)
`POST /schedules/:sid/runs` (run-now) → `202 {runId}` for test target, `202 {suiteRunId}` for suite target; `404 NOT_FOUND` / `400 VALIDATION_ERROR` on fire failure

Schedule fields: `notifyOnFailure: boolean` (default `false`), `lastStatus: string | null` (settlement outcome; `null` before first fire).

## AI (preview-only, never persists)
`POST /ai/gherkin`
- Request: `{"text":"...","projectId":"...?"}` (`text` 1–8000 chars; `projectId` optional, requires read access)
- Returns: `{engine:'rules', steps, unparsed, warnings, tags, scenarioName?}` (deterministic Vietnamese-Gherkin parser, no LLM)

## Integrations (webhook provider)
`GET /projects/:projectId/integrations`
`POST /projects/:projectId/integrations`
`PATCH /integrations/:id`
`DELETE /integrations/:id`
- Provider `webhook`: `config.url`, `secrets.signingSecret` (optional)
- Delivery: `POST {url}` with headers `X-VV-Event: <event>`, `X-VV-Signature: v1=<hex hmac-sha256(raw, signingSecret)>` (only when `signingSecret` set); body `{event, title, markdown[, runUrl]}`
- Run-terminal fan-out (fire-and-forget, never fails the run): `run.passed | run.failed | run.cancelled`

## Plugins
`GET /plugins` → `{enabled, dirName, plugins}` (`dirName` is basename of plugin dir, never a server absolute path)
`POST /plugins/reload` (Developer/Admin + `ALLOW_PLUGINS=1`) → same shape

## Errors (RBAC / conflicts)
| Code | Status | When |
|---|---|---|
| `FORBIDDEN` | `403` | project viewer, global viewer, or non-member on any write |
| `CONFLICT_ACTIVE_RUNS` | `409` | delete under live (`queued`/`running`) runs — cancel runs first |
| `NOT_FOUND` | `404` | unknown id |
| `VALIDATION_ERROR` | `400` | schema/target/cron failure |

All write endpoints validate authorization and payload schema. Use stable machine-readable error codes plus human-readable messages.
