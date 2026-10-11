# SiroTest MCP server (operator setup)

`apps/mcp` (`@playwright-studio/mcp`) exposes Studio as model tools over
stdio: projects, tests, spec export, runs, healing proposals, Vietnamese
Gherkin parse, failure explain. It owns no browser/DB/secrets — every tool
calls the EXISTING Studio REST API with a Bearer token.

This is the control plane (what to test, did it pass, why did it fail).
For raw browser driving, pair it with upstream `@playwright/mcp`.

## Run it

```bash
pnpm --filter @playwright-studio/mcp build
STUDIO_API_URL=http://127.0.0.1:3001 STUDIO_TOKEN=<token> node apps/mcp/dist/index.js
```

`STUDIO_TOKEN` is required. Any project token works; RBAC applies —
a viewer token can list/explain but cannot queue runs.

## Client config (opencode)

```json
{ "mcp": { "sirotest": {
  "type": "local",
  "command": ["node", "D:/path/to/playwright-vv/apps/mcp/dist/index.js"],
  "environment": { "STUDIO_API_URL": "http://127.0.0.1:3001", "STUDIO_TOKEN": "<token>" },
  "enabled": true } } }
```

## Tools (12)

- `studio_list_projects` / `studio_list_tests` / `studio_get_test`
- `studio_export_spec` — readable `.spec.ts` for the model to quote
- `studio_create_run` (async, returns runId) / `studio_get_run` (poll it)
- `studio_check_stability` — N× gate (sync, minutes) / `studio_score_rubric` — 0-100 without a browser
- `studio_get_trajectory` — agent timeline for a run (feed it to an LLM to analyze failures)
- `studio_list_healing` — pending proposals (read-only; approve stays human-only in the UI)
- `studio_parse_gherkin` — VI Gherkin → steps + explicit unparsed lines
- `studio_explain_run` — failure category + causes + fixes (Vietnamese)

## Safety notes

- Token travels in the `Authorization` header only — never in tool results.
- Run summaries truncate step errors (2k chars); test summaries omit the
  full definition unless `includeDefinition=true` (token budget).
- No approve/reject/delete tools by design (proposal-only healing, RBAC deletes).
