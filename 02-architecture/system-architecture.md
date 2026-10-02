# System Architecture

```text
React Studio UI
   │ REST + WebSocket
   ▼
Fastify API / Orchestrator
   ├── Project/Test service
   ├── Environment/Secret service
   ├── Recorder session manager
   └── Run manager
          │
          ├──────────────► Recorder Worker ─► Playwright Browser
          │
          └──────────────► Compiler ─► Runner ─► @playwright/test
                                      │
                                      └─► artifacts + reporter events

SQLite/Postgres                         Local/S3-compatible storage
```

## Boundaries
- UI never executes arbitrary Playwright directly.
- Test model package contains no database/UI dependency.
- Compiler is a pure transformation where practical.
- Runner executes generated files in isolated run workspaces.
- Recorder and runner browser contexts are disposable.

## P0 process model
API, recorder and runner may run on one host. Queue may be in-process with a concurrency limit. Preserve interfaces so P1 can move execution to worker processes/BullMQ without changing the test model.
