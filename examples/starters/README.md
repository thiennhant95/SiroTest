# Starter examples

Three small, runnable tests against public sites — the fastest way to see the
tool work end to end. They are **read-only** (no sign-up, no purchases), so they
are safe to run as often as you like.

| File | What it proves | Target |
|---|---|---|
| `todomvc-add-todo.json` | fill + press + assertion | demo.playwright.dev/todomvc |
| `saucedemo-login.json` | login flow with assertions | saucedemo.com (public test site) |
| `wikipedia-search.json` | role locators + URL assertion | en.wikipedia.org |

## Import (30 seconds)

With the server running (local or hub):

```powershell
$env:STUDIO_API_URL='http://127.0.0.1:3001/api/v1'
$env:STUDIO_TOKEN='tester-1'      # dev mode; use a session token on a hardened host
node scripts/import-examples.mjs
```

The script creates one project per file (reuses it on re-run), a default
environment, and the test. Then open the project → test → **Run**.

## Use them as templates

Open a test → **Gherkin** tab shows the same flow in Vietnamese, or duplicate the
test and edit steps. The JSON under `examples/starters/` is the same shape the
tool stores, so you can copy a file, change the URLs, and re-import.

## Notes

- These run against third-party sites: if a site changes, the test may fail.
  That is the point — it shows how the tool reports a real break.
- Nothing is written to those sites (no accounts created, no data submitted
  beyond a search or a public demo login).
