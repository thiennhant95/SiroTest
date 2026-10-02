# Artifacts & Reporting

Per run:
```text
storage/runs/<run-id>/
├─ result.json
├─ trace.zip
├─ video.webm        # if enabled
├─ screenshots/
└─ playwright-report/ # optional retention
```

P0 result UI shows summary, timeline, each step status/duration, failed-step error, screenshot and **Open Trace**.

Use Playwright Trace Viewer rather than rebuilding it. Artifact retention should be configurable; P0 default can be 14–30 days.

Redaction must occur before storing user-facing logs. Do not expose secret variable values in result JSON, filenames or screenshots metadata.
