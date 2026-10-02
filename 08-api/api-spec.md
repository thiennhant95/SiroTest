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

All write endpoints validate authorization and payload schema. Use stable machine-readable error codes plus human-readable messages.
