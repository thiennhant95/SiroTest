# Runner Specification

## P0 lifecycle
1. Validate test definition.
2. Resolve selected environment/variables.
3. Create isolated temp run directory.
4. Compile spec/config.
5. Execute Playwright with custom reporter.
6. Stream run/step events over WebSocket.
7. Persist status/duration/error/artifact metadata.
8. Cleanup temp source while retaining configured artifacts.

## Status
Run: `queued | running | passed | failed | cancelled`.
Step: `pending | running | passed | failed | skipped`.

## Concurrency
P0 default 1–2 concurrent runs per host, configurable. Queue excess runs. Do not let recorder sessions starve execution workers.

## Timeouts
Project default → test override → step override. UI must make overrides visible.

## Cancellation
Runner must terminate child Playwright process tree and mark incomplete step/run cancelled.

## Isolation
Each run gets unique working directory and browser context. Never reuse test state unless explicitly using an auth/storage-state feature in P1.
