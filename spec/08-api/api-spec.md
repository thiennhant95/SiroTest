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
`POST /recorder/:sessionId/stop` (persists draft steps, mints version)
`POST /recorder/:sessionId/interrupt`
`GET /recorder/:sessionId`
`POST /recorder/:sessionId/locator/pick`
`POST /recorder/:sessionId/locator/test`
`POST /recorder/:sessionId/assertion/pick`
`POST /recorder/:sessionId/assertion` (appends assertion step)

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
`GET /runs/:id/trajectory` → agent timeline (ordered steps with type/status/timings/truncated errors + artifact refs; server paths stripped)

## Stability gate + rubric
`POST /tests/:id/stability` → `200 {runs, passed, total, stable}` (runs the standard run path N=2–5× sequentially, sync; stamps `Test.stable` only on N/N)
`POST /tests/:id/stability {async: true}` → `202 {gateId, status, total, poll}` (same loop in background; cancel-safe)
`GET /tests/:id/stability/gates/:gateId` → `{gateId, status: queued|running|passed|failed|cancelled, passed, total, stable, runs[], error}` (poll every ~3s)
`DELETE /tests/:id/stability/gates/:gateId` → marks cancel, kills the current child run, settles `cancelled` (idempotent)
`GET /tests/:id/stability` → `{stable, stableAt, stableRuns}` (any definition PATCH clears the stamp)
`GET /tests/:id/rubric` → `{score/100, checks[]}` (stable-primaries 30, alternatives 15, no-hard-waits 15, assertions 20, named 10, enabled 10; pure, nothing runs)

## Suggestions (deterministic + opt-in LLM extras)
`POST /tests/:id/suggestions {sessionId?|steps?, assist?}` → `{suggestions[] (each engine:'rules'|'llm'), assist?: {engine, added, dropped, note}}` (rules always; `assist:true` appends schema-validated LLM extras, invalid dropped + counted, no LLM → rules-only note)
`POST /tests/:id/suggestions/apply {suggestionIds|indexes, position?}` → inserts + versions (unknown ids fail loud)

## Healing (explicit, human-approved only)
`GET /tests/:id/healing?status=pending|approved|rejected|all` → proposals with deterministic `score` 0–100 + `scoreReasons[]` (verified 40 + unique match 30 + winner-strategy stability 15 + decisiveness 10 + DOM preview 5; review aid, never auto-applies)
`POST /healing/:pid/approve` → rewrites the step primary, demotes the old primary to alternatives head, mints a version (voids the stability stamp)
`POST /healing/:pid/reject` → terminal reject, definition untouched

## Audit
`GET /projects/:projectId/audit?action=&userId=&limit=&offset=` → project-scoped evidence trail (viewer+ may read; secrets redacted in `details`).

Recorded actions include: `project.create`, `project.delete` (project-less orphan row — the project's own trail cascades on delete), `test.duplicate`, `test.restore`, `test.delete`, `suggestions.apply`, `suite.delete`, `suite.tests.add/move/replace/remove`, `stability.gate_created`, `stability.gate_cancelled`, `stability.verdict` (with `stale: true` when a mid-gate edit discarded the verdict), `worker.stale-requeue`, `worker.marked-offline`, `worker.revive`, `healing.approve`, `healing.reject`, `variable.create/update/delete` (key/scope/flags only — values never), `integration.create/update/delete` (provider/name only — secrets never), `schedule.create/update/delete`, `schedule.run-now`, `transfer.import` (counts only), `dataset.import/delete` (names+counts only — cell content never), `profile.create/update/delete` (name/scope only), `action.create/update/delete`, `environment.create/delete`, `file.delete`, `baseline.promote/delete`, `bug.report`.

Durability rule: on paths that report the recorded change in the response, the audit row is awaited before responding — a client reading `/audit` immediately after never observes an empty trail.

## Spec import
`POST /projects/:projectId/import-spec` → `201 {test (draft), warnings[]}` (subset: goto/reload/nav/waits, getBy*/page.locator + actions, expect() assertions; multi-`test()` merge warns)
`POST /projects/:projectId/import-junit` → `201 {tests[] (draft shells), warnings[]}` (JUnit `<testcase>` → draft shell with the original status/message in the description; shells have no steps until recorded; no cases → `422 JUNIT_NO_CASES`, non-JUnit → `400`)

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
- Request: `{"text":"...","projectId":"...?","assist":true?}` (`text` 1–8000 chars; `projectId` optional, requires read access)
- Returns: `{engine:'rules', scenarioNameSource:'rules'|'llm', steps, unparsed, warnings, tags, scenarioName?}` (steps always deterministic rules; opt-in `assist` lets an LLM propose only the scenarioName, rules name stays as fallback)

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
