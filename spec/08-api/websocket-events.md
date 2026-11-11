# WebSocket Events

Namespace/channel may be implementation-specific; event payloads require `sessionId` or `runId`.

## Recorder
- `recorder.started`
- `recorder.stepCaptured`
- `recorder.locatorPicked`
- `recorder.paused`
- `recorder.resumed`
- `recorder.interrupted`
- `recorder.stopped`

## Run
- `run.queued`
- `run.started`
- `step.started`
- `step.passed`
- `step.failed`
- `run.passed`
- `run.failed`
- `run.cancelled`

Events are informational; database state remains authoritative. Client reconnect should fetch current run/session state instead of assuming no events were missed.
