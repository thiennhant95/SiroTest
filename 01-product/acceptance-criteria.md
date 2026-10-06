# MVP Acceptance Criteria

MVP is shippable when all conditions below pass:

- A non-coding tester can record a login/search/CRUD-style flow without editing source code.
- Recorded typing is merged into `fill` steps rather than per-key noise.
- Recorder prefers semantic locators and never chooses brittle nth-child CSS when a semantic candidate exists.
- Tester can reorder, disable, duplicate, delete and edit steps.
- Tester can add at least Visible, Text contains, Value and URL assertions.
- Variables resolve by selected environment; secret values never appear in run logs or generated literal code.
- A test definition deterministically compiles to valid Playwright TypeScript.
- A run streams step state and produces pass/fail result.
- On failure, screenshot + error are available; trace is available when tracing is enabled.
- Generated code can run under upstream `@playwright/test` without Studio runtime dependencies, except explicitly exported helper/custom-action packages.
- Existing test definitions remain readable after application restart.
- Unit/integration tests cover model validation, compiler and locator conversion.

## Post-MVP (shipped 2026-10)
- Project viewer is read-only; outsiders get 403; deletes under live runs fail 409 with an explicit message.
- Schedules record lastStatus and can notify Slack/Lark/webhook on failure (opt-in).
- Healing never applies silently: proposals are verified, reviewed, versioned.
- Secrets stay encrypted at rest, masked on read, redacted in logs/artifacts.
