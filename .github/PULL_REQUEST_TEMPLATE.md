## What changed

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The user problem or the bug this solves. -->

## How I verified it

- [ ] `pnpm typecheck`
- [ ] Relevant tests (unit / security / server-unit / integration / e2e)
- [ ] Manual check in the UI (describe what you clicked)

## Checklist

- [ ] JSON `TestDefinition` remains the source of truth (no silent mutation)
- [ ] No secret values in code, logs, fixtures or generated output
- [ ] No Playwright core fork; generated code still parses/typechecks
- [ ] Docs updated if behaviour or configuration changed
