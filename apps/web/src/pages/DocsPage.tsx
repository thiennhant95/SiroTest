import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

interface DocSection {
  id: string;
  group: string;
  title: string;
  body: string;
}

const SECTIONS: DocSection[] = [
  {
    id: "quickstart",
    group: "Start",
    title: "Quickstart (your first test)",
    body: `This guide takes you from login to a green run in about 10 minutes.

## 1. Log in
Open the app and use the **Dev** tab with a user id (e.g. \`tester-1\`), or **Sign up** for a real session account. Your name appears top-right; **Log out** is next to it.

## 2. Create a project
**Projects → + New project.** Fill name (required), description and base URL (e.g. \`https://staging.example.com\`). The base URL becomes the default target of every run.

## 3. Create an environment
Open the project → **Environments** (or the ⚙ Envs button in the Builder). Add e.g. \`staging\` with its base URL and mark it default. Runs always target one environment.

## 4. Add variables (optional but recommended)
Builder → **Variables** tab → Add \`BASE_URL\`, and secrets like \`ADMIN_PASSWORD\` with the **secret** checkbox. Secrets are encrypted, never shown again, and redacted everywhere. Use them as \`{{BASE_URL}}\`, \`{{ADMIN_PASSWORD}}\` in any URL, fill value, header or body.

## 5. Build the test (login example)
**Tests → + New test.** In the Builder press **+ Add step** (search: "goto", "fill", "click", "assert"):

| # | Step | Details |
|---|---|---|
| 1 | Go to page | \`{{BASE_URL}}/admin/login\` |
| 2 | Fill text field | placeholder \`Email Address\` ← \`{{ADMIN_EMAIL}}\` |
| 3 | Fill text field | placeholder \`Password\` ← \`{{ADMIN_PASSWORD}}\` (sensitive) |
| 4 | Click | button \`Sign In\` (role+name) |
| 5 | Assert URL | pattern \`**/admin/dashboard*\` |
| 6 | Assert page title | \`Dashboard\` |
| 7 | Take screenshot | evidence for the run |

Click a step to edit it in the **Inspector** (right panel). Steps autosave — watch the **Saved** badge in the toolbar.

## 6. Run it
Press **▶ Run** → pick environment + browser → **Start run**. The run page streams every step live (\`WS: connected\`). Green means passed; open **Evidence** below for screenshots.

> Tip: tick **Observe closely** on important runs to keep trace/video even on passes.

## Worked example — company login (demo-print)
| # | Step | Value |
|---|---|---|
| 1 | Go to page | \`https://demo-print.vietvang.net/login\` |
| 2 | Fill | textbox "Email Đăng Nhập" ← \`ci.smoke.company@in3m.local\` |
| 3 | Fill (sensitive) | textbox "Mật Khẩu" ← \`{{CA_PASS}}\` |
| 4 | Click | button "Login" |
| 5 | Assert page title | \`Công ty | Dashboard\` |

Expected: 5/5 green in ~8s. If step 5 fails, open the step — Short error + Locator render inline. Most login failures are a wrong password (the app reloads an empty form), not a bad locator — check the screenshot before touching locators.`,
  },
  {
    id: "concepts",
    group: "Start",
    title: "Core concepts",
    body: `## TestDefinition is the source of truth
A test is a versioned JSON document. The visual editor and the compiler both operate on JSON; TypeScript is output only (see the **Code** tab). Never edit generated code expecting it to stick — edit the steps.

## Isolation
Every run gets a **fresh browser context**: clean cookies, clean storage. Tests never leak login state into each other. Reuse login via **Auth profiles** (saved storage state), never by sharing contexts.

## Variables & secrets
- \`{{NAME}}\` resolves at run time from project + environment variables.
- Secret values are **AES-256-GCM encrypted** in the DB, injected at run time, redacted in logs, results, artifacts and API responses.
- A \`sensitive\` fill **must** reference \`{{VARIABLE}}\` — plaintext secrets are rejected at compile time.

## Locators: primary only
Each step stores a **primary** locator plus ranked **alternatives**. The runner executes the primary only and fails explicitly otherwise. Alternatives are evidence for future repair — the P0 engine never silently switches locators.

| Priority | Strategy | Example |
|---|---|---|
| 1 | Role + accessible name | button "Sign In" |
| 2 | Label | label "Email" |
| 3 | Placeholder | placeholder "Email Address" |
| 4 | Test ID | testId "submit" |
| 5 | Stable text | text "Dashboard" (exact) |
| 6 | Stable CSS | \`input[name="email"]\` |
| 7 | XPath fallback | scoped XPath |

A locator matching **0** elements cannot be saved as healthy; **2+** matches raise a strict-mode warning — narrow it (exact text, scoped XPath, CSS by name).

## Example — the \`***CA_PASS***\` incident
A tester copied a masked display value (\`***CA_PASS***\`) into a password fill. The fill step **passed** (Playwright filled exactly what it was told), login was rejected, the app reloaded an empty form. Lesson encoded in the compiler: a \`sensitive\` fill whose value is not a \`{{VARIABLE}}\` reference fails compilation — the machine refuses to run what it cannot keep secret.`,
  },
  {
    id: "locators",
    group: "Start",
    title: "Locator cookbook",
    body: `## The 3 rules that prevent 90% of flakes
1. **Prefer role+name** for buttons/links/headings (\`getByRole\` uses the accessibility tree — stable across restyles).
2. **Placeholder beats CSS** for inputs when the design team renames classes weekly.
3. **Duplicate text? scope it.** Two "Save" buttons → wrap in a container XPath or pick the heading role instead of text.

## Common fixes

| Symptom | Fix |
|---|---|
| \`strict mode violation: resolved to 2 elements\` | exact text, or CSS \`input[name="email"]\` instead of placeholder substring |
| \`element(s) not found\` right after deploy | UI changed — run Test locator, pick the new primary, keep old as alternative |
| Dropdown options (vue-multiselect etc.) | click wrapper → fill searchbox → click exact option text; add a small wait for async lists |
| Toast/assertion disappears | assert on something stable instead (URL, button still present) — never assert on auto-dismissing toasts as the primary check |

## Test locator button
In the Inspector, **Test locator** reports 0/1/N matches live against a recorder session or the test page. Red (0) blocks saving as healthy.

## Real cases from the pilot
| Symptom | What it was | Fix |
|---|---|---|
| \`getByRole('link', { name: '…' })\` resolved to **4** elements | A nav link text repeated in footer/sidebar | Use the link for navigation via \`goto\`, or scope to CSS \`#col-… a\` |
| Click "QUẢN LÝ HÓA ĐƠN" hung 60s then failed | Not logged in (bad password) → menu never rendered | Fix the login, not the click — check prior steps first |
| \`tr:has-text("vv…@…")\` + delete link | Row-scoped action without knowing the numeric id | CSS \`tr:has-text("email") a[href*="/delete/"]\` isolates one row |
| Edit link opens a **new tab** (\`target=_blank\`) | Runner stays on the original page | Navigate directly: \`goto /admin/user/edit/{id}\` |`,
  },
  {
    id: "run-modes",
    group: "Running",
    title: "Run modes",
    body: `The Run dialog offers four modes plus viewport and healing options:

| Mode | What happens | Playwright equivalent | When to use |
|---|---|---|---|
| Default (nothing ticked) | Headless, fastest | \`playwright test\` | Daily/CI runs |
| Headed | Real Chromium window on the host | \`--headed\` | Watch it with your eyes |
| Observe closely | Headed + 500ms slow-mo + trace/video kept on passes | \`--headed --slow-mo=500\` + \`trace/video: 'on'\` | Debug a confusing run |
| Debug | Playwright Inspector on the host | \`--debug\` | Step through, breakpoints, try locators live |

## Viewport override
Run the same test at Desktop 1440×900 down to Mobile 375×667. Combine with \`screenshot\` steps for responsive evidence.

## Heal with alternatives
On locator failure, tries stored alternatives and files a reviewable **Healing proposal**. The step still fails — nothing is auto-applied. Review in **Tests → Healing**, Approve rewrites the primary (old primary demoted to alternatives).

> Warning: Debug runs stay \`running\` until you close the Inspector or press **Cancel**. Never schedule headed/debug runs.

## When to use which — pilot examples
- **Default**: nightly suite runs, CI.
- **Headed**: first run of a new test, or a live customer demo (they trust what they see).
- **Observe closely**: the "false-pass fill" case — the fill step reported pass while the form visibly cleared. The 6-second video proved it (value present at second 3, gone at second 6); the trace showed \`fill("***…")\` followed by a login POST that 302-redirected back to \`/login\`. Without artifacts this would have been an argument; with them it was a diagnosis.
- **Debug**: strict-mode 4-matches failure — try the narrower locator live on the real page before editing the test.
- **Heal with alternatives**: dev restyled the UI overnight — run once to collect "alternative X would have matched" evidence, then approve in Healing. Nothing applies itself, ever.`,
  },
  {
    id: "evidence",
    group: "Running",
    title: "Evidence (screenshots / video / trace)",
    body: `## What is kept
- \`result.json\` — always (status, durations, errors, step table).
- **Screenshots** — every \`screenshot\` step is always persisted, pass or fail.
- **Trace/video** — kept on failure by default (\`retain-on-failure\`); tick **Observe closely** to keep them on passes.

Limits: 50 MB per artifact, 100 screenshots per run, 14–30 day retention.

## How to review
- **Screenshots** render inline in a gallery grid.
- **Video** plays inline (downloaded with auth — plain links cannot carry credentials).
- **Trace** downloads as \`trace.zip\`. Open it with:

\`\`\`
npx playwright show-trace trace.zip
\`\`\`

…or drag the file into https://trace.playwright.dev. The trace shows every action, DOM snapshot, network call and console line — it is the single best debugging artifact for a red run.

## Reading a trace — worked mini-example
Open the trace of a failed login run and check three things in order: (1) the **Actions** lane — did each \`fill\` carry the expected value? (2) the **Network** lane — did the login POST return 302 back to \`/login\` (rejected) or 200 forward (accepted)? (3) a **DOM snapshot** right after submit — is the form empty with a red validation line, or did it navigate away? In our pilot this exact sequence proved "wrong password, not a bad locator" in two minutes.`,
  },
  {
    id: "suites",
    group: "Running",
    title: "Suites & schedules",
    body: `## Suites
**Suites** group tests into one ordered run: sequential (\`parallel: 1\`) or up to 2 parallel, with optional retries per test. Create one in the project → Suites page, add member tests, then **Run suite**. Each member produces its own run row; the suite aggregates pass/fail.

Good suite hygiene:
- Keep order-placing tests **out** of suites (each member run is real).
- Put slow/flaky-but-important tests with \`retries: 1–2\`, not more.
- Tag smoke tests (\`smoke\`) and run the tag subset before the full suite.

## Schedules
Trigger a suite or a single test on cron:

\`\`\`
0 7 * * *      # daily at 07:00
*/15 * * * *  # every 15 minutes
0 9 * * 1-5    # weekdays 09:00
\`\`\`

Create them in **Schedules** (suite or test + environment + cron). Keep the switch **disabled** until the target is side-effect free, and never schedule headed/debug runs.

## Worked example — "DP - Vòng đời người dùng"
Five tests in order: SuperAdmin login → create user → edit user → login as the new user → open orders. Tests 2–3 carry \`writes\` tags, so the Run dialog shows the amber side-effect warning ("may create real data") — it warns, never blocks. Each member runs in its own fresh browser context, so no logout steps are needed between the admin and the new-user sessions. Re-running from scratch needs a fresh email: this app soft-deletes users and reserves the address forever, so the suite documents its test account (\`NEW_USER_EMAIL\`) instead of pretending to be repeatable.`,
  },
  {
    id: "schedule-alerts",
    group: "Running",
    title: "Schedule failure alerts",
    body: `## Opt in per schedule
New/edit schedule dialog → tick **Notify on failure**. The row shows a **notify on failure** badge.

## Needs an enabled chat integration
**Settings → Integrations** (per project): add **Slack** (incoming webhook URL) or **Lark** (custom bot webhook URL) and keep it **enabled**. No enabled Slack/Lark → the failure is logged, nobody is pinged.

## What happens
A failed scheduled run posts one message (target suite/test, run id, error summary) and the row updates **last run failed** / \`last <status>\`. Passing and cancelled runs never notify.

> Best-effort: delivery failures are logged, never retried, never fail the run. Still red on the next firing → notified again.`,
  },
  {
    id: "webhooks",
    group: "Running",
    title: "Webhook run events",
    body: `## Setup
**Settings → Integrations** → provider **Webhook (run events)**: \`url\` + optional \`signingSecret\` (stored encrypted, never shown). Only **enabled** webhooks receive events.

## Verification
Every delivery carries \`X-VV-Event\` (\`run.passed\` / \`run.failed\` / \`run.cancelled\`). When \`signingSecret\` is set it also carries \`X-VV-Signature: v1=<hex>\` = HMAC-SHA256 of the raw JSON body. Reject mismatches — see \`docs/notify-webhooks.md\` for the snippet.

> Best-effort, no retries: delivery failures are logged and never fail the run. Terminal outcomes only.`,
  },
  {
    id: "api-tests",
    group: "Testing",
    title: "API tests",
    body: `## apiRequest — call a real API
Method, URL, headers, body (all support \`{{VARIABLES}}\`), explicit \`expectedStatus\`, and \`saveAs\` to reuse the response text later:

| Field | Example |
|---|---|
| Method + URL | \`GET\` \`{{BASE_URL}}/api/health\` |
| Headers | \`X-Edge-Api-Key: {{EDGE_API_KEY}}\` (secret) |
| expectedStatus | \`200\` — mismatch fails explicitly, never silently |
| saveAs | \`HEALTH\` → later steps use \`{{HEALTH}}\` |

Negative cases are first-class: expect \`401\` without a key, \`400\` on bad input.

## mockRoute — fake the API, test the UI
Intercepts browser traffic **before** the app fires it. Place it **before** the triggering \`goto\`/\`click\`:

| Field | Example |
|---|---|
| URL pattern | \`**/api/checkout/onepage/summary\` |
| Method filter | optional — other methods go to the real network |
| Status / body | \`500\` + \`{"error":"mocked"}\` |

Real-world use: we mocked the checkout summary to 500 and proved the storefront hangs on skeleton loaders forever — no error state, no retry. That finding went straight to the web team.

## Mixing UI + API
One test can do both: \`apiRequest\` to set up data (or assert backend state), then UI steps to verify what the tester sees. Secrets stay masked in both worlds.`,
  },
  {
    id: "a11y",
    group: "Testing",
    title: "Accessibility & visual",
    body: `## axeCheck — axe-core scans
Runs axe (WCAG 2.0/2.1 A+AA) and fails listing rule ids:

\`\`\`
axeCheck 's3': 2 violation(s): color-contrast[serious], link-name[serious]
\`\`\`

- **CSS scope** narrows the scan (empty = whole page).
- **Fail on impacts**: critical / serious / moderate / minor (default: critical+serious).
- **Skip rules** one per line for accepted issues (e.g. \`color-contrast\` on brand art).

Real example from this pilot: the staging homepage fails \`select-name[critical]\` + three serious issues — concrete tickets, not vibes.

## visualCheck — screenshot regression
Diffs against a stored baseline within a threshold. Workflow: run once in capture mode to mint the baseline, then every later run diffs. Pixel diffs catch unintended restyles; they cannot judge good design — review the actual/diff images.`,
  },
  {
    id: "responsive",
    group: "Testing",
    title: "Responsive testing",    body: `## Workflow
1. Open the Run dialog → **Viewport** → pick Mobile 375×667 (or 390×844, Tablet 768×1024…).
2. Keep \`screenshot\` steps (or \`visualCheck\` baselines per size) in the test.
3. Compare: same flow, three widths. Broken layout, missing buttons and overflow show up as diffs or failed \`assertVisible\` steps.

## What the machine can and cannot do
- CAN: prove nothing changed vs baseline; prove key elements stay visible at every width.
- CANNOT: judge aesthetics or tap-target comfort — a human reviews the screenshots.

Combine with \`axeCheck\` (contrast, labels) for an objective responsive pass.`,
  },
  {
    id: "gherkin",
    group: "Testing",
    title: "Gherkin tab (Vietnamese)",
    body: `## Where
Builder → **Gherkin** bottom tab (next to Suggest). Paste \`Cho rằng / Khi / Thì\` text → **Parse** → preview → **Insert N step(s) at end of test** (a normal versioned save).

\`\`\`
Kịch bản: Đăng nhập thành công
  Cho rằng mở trang https://staging.example.com/admin/login
  Khi nhập "Email Address" là "admin@example.com"
  Và bấm nút "Sign In"
  Thì kiểm tra "Dashboard" hiển thị
\`\`\`

## Honest limits
- \`Bối cảnh:\` (Background) steps are prepended to the scenario.
- First scenario only — later \`Kịch bản:\` blocks go to **Warnings**, not steps.
- Unrecognized lines go to **Unparsed lines** (red). The parser never invents steps — fix the line or add the step by hand.
- Tags (\`@smoke\`) show as badges for later filtering, never written into the test.

## Worked example — login + filter, with the two classic traps
\`\`\`
Kịch bản: Đăng nhập công ty và lọc hóa đơn cần xử lý
  Cho rằng mở trang https://demo-print.vietvang.net/login
  Khi nhập "Email Đăng Nhập" là "ci.smoke.company@in3m.local"
  Và nhập "Mật Khẩu" là "THAY_BANG_CA_PASS"
  Và bấm nút "Login"
  Và mở trang https://demo-print.vietvang.net/orders-new?page=1
  Và bấm nút "Tìm Kiếm"
  Thì kiểm tra "Hóa Đơn Cần Xử Lý" hiển thị
\`\`\`

After Insert, two mandatory fixes: (1) replace the \`THAY_BANG_CA_PASS\` placeholder with \`{{CA_PASS}}\` — never paste a real password into Gherkin text; (2) a \`Và mở trang…\` line that lands in **Unparsed** (red) should be deleted from the block and re-added by hand as Go to page — the parser is most reliable with \`mở trang\` in the \`Cho rằng\` line. If the final \`Thì\` fails, open the real page: after filtering it may show "Không có dữ liệu" instead of your expected text — update the expectation, Test locator to 1 match, re-run.`,
  },
  {
    id: "stability",
    group: "Testing",
    title: "Stability gate + rubric",
    body: `## Certify a definition (not a single pass)
Builder header shows the stamp: **Stable 3/3** (green) or **Not stable** (slate), plus **Rubric N/100**. Click **Check 3×** (needs an environment) to run the same test 3 times sequentially in the background — progress shows **Checking i/3…** with a **Cancel** button; the stamp is set only on 3/3 passes. Any edit clears it: stable describes the exact definition that passed, nothing else.

## Rubric (0–100, no browser needed)
Scores the stored definition: stable primaries 30, backup locators 15, no hardcoded sleeps 15, assertions 20, named steps 10, all enabled 10. Fix the red checks before spending gate runs.

## Trajectory export (for agents)
\`GET /runs/:id/trajectory\` returns an agent-consumable timeline: ordered steps (type/status/timings/truncated errors) + artifact refs. Feed it to an LLM to analyze failures. Secrets stay redacted, server paths stripped.`,
  },
  {
    id: "ai-providers",
    group: "Reference",
    title: "AI providers (rules vs LLM)",
    body: `## Default: rules (deterministic, offline)
Explain, compose, cleanup and Gherkin all run local rule engines — every response carries \`engine: 'rules'\`. No key, no network, no surprises.

## Opt-in LLM (keyless available)
Set \`AI_PROVIDER=kilo\` or \`AI_PROVIDER=uncloseai\` (no key, anonymous free tier) or a classic \`AI_API_KEY\` endpoint. Comma lists try in order: \`AI_PROVIDER=kilo,uncloseai\`. LLM failures fall back to rules; \`engine: 'llm'\` only when the model really answered.

## Per-task model (reasoning where it pays)
\`AI_MODEL\` is the cheap default for interactive tasks (compose/cleanup). \`AI_EXPLAIN_MODEL\` overrides the model for failure explanation only — e.g. a pro/reasoning model — same endpoint and key, reported as \`explainModel\` in \`GET /ai/status\` and shown in the Explain tab.

## Privacy
Project secret values are redacted before anything reaches an LLM. Free tiers may log prompts upstream — do not send confidential data through them.

> ⚠️ **Enterprise warning — keyless free tiers (\`kilo\`, \`uncloseai\`)**
> These are anonymous, rate-limited third-party gateways: prompts may be logged upstream and there is no DPA.
> Studio redacts project secret *values* before sending, but step names, URLs, selectors and failure text still go out.
> For confidential work set \`AI_API_KEY\` to your own OpenAI-compatible endpoint (or leave AI unset — rules engines run offline and are the default).
>
> ✅ **Recommended for teams: self-hosted gateway.** Point \`AI_BASE_URL\` at your own OpenAI-compatible gateway (with \`AI_API_KEY\` + \`AI_MODEL\`, e.g. \`gemini-2.5-flash\`) — prompts stay inside your infrastructure, no third-party logging, and the keyless-tier warning does not apply. Studio-side secret redaction still runs as defense in depth.`,
  },
  {
    id: "ai-features",
    group: "Reference",
    title: "AI features (the 6 touchpoints)",
    body: `Every AI answer carries an engine badge. \`rules\` = deterministic local engine (always present). \`llm\` = the model really answered (falls back to rules on any failure — never fabricated).

| # | Where | What the AI does | Example |
|---|---|---|---|
| 1 | Run page → **Explain with AI** | Explains one failed run in Vietnamese (cause + fix) | A step-timeout on a register rerun: verify against the screenshot before trusting it (see below) |
| 2 | AI Assistant → **Compose** | Turns a description into draft steps | "đăng nhập công ty rồi mở Hóa Đơn Cần Xử Lý" → 4 steps, 0 unparsed |
| 3 | AI Assistant → **Explain** | Full version of #1 for deep follow-up questions | "Why did step 6 time out?" after the one-click summary |
| 4 | AI Assistant → **Clean up recording** | Tidies a raw recording (dedupes, renames) — **rules engine, not LLM** | 8 recorded steps → 8 kept, 3 renamed/merged; do not demo this as "AI" |
| 5 | Suggest → **Assist with AI** | Extra assertion proposals beyond the rules (\`llm\`-tagged, schema-validated) | 6 suggestions on an orders test, 1 from the model — review before Insert |
| 6 | Gherkin → **Name with AI** | Names the scenario only (\`scenarioNameSource: 'llm'\`); steps always come from rules | "Đăng nhập và mở hóa đơn công ty" instead of the raw first line |

## Reading an explanation honestly
The explainer sees the **error text** plus run context (test name, which prior steps passed) — not the screenshot. A timeout assert after 5 green fills + submit usually means the app never navigated (validation/duplicate data), not a slow network — the prompt now says so and caps confidence at \`medium\` without page-state evidence. Rule for testers: read the explanation in 10 seconds, then corroborate with the run screenshot/video. A \`high\` confidence on a generic timeout is a smell, not a verdict.`,
  },
  {
    id: "bug-reports",
    group: "Running",
    title: "Bug reports (Jira / Backlog / Slack / Lark)",
    body: `## One click from a red run
Open any finished run → **🐞 Report bug**. You get a Markdown report (summary, error, failed steps, artifacts) to preview, download as \`.md\`, or file directly.

## Connect a destination
**Settings → Integrations** (per project): pick Jira Cloud, Backlog, Slack or Lark, fill the workspace fields, paste tokens. Secrets are encrypted at rest and never returned by the API.

| Provider | Needs |
|---|---|
| Jira Cloud | site, project key, issue type + email, API token |
| Backlog | space, project + issue-type ids + API key |
| Slack | incoming webhook URL |
| Lark | custom bot webhook URL |

Filing is always explicit — nothing auto-files. Every delivery is audit-logged.

## Worked example — Backlog
Create the integration once per project (**Settings → Integrations → Backlog**): \`space\` = your \`https://….backlog.com\`, \`projectId\` = the **numeric** project id (resolve it via \`GET /api/v2/projects/{KEY}\`), \`issueTypeId\` = the numeric Bug type id, \`priorityId\` = e.g. Normal — some Backlog projects **require** it and reject without (HTTP 400 \`priorityId is required\`), plus the \`apiKey\` secret (encrypted, never returned). Then open any red run → **Report bug** → optional custom summary + screenshots → file. We verified this end-to-end with a \`[TEST]\`-prefixed issue before handing the button to testers.`,
  },
  {
    id: "troubleshooting",
    group: "Reference",
    title: "Troubleshooting",
    body: `## No access to project \`xxx\`
You are logged in as a different user than the project owner — ask for membership or log in as the owner.

## Strict-mode violation (resolved to 0 / 2+ elements)
See **Locator cookbook**. Most common: placeholder substring (\`Tên\` also matches \`Tên công ty\` → use CSS \`input[name="…"]\`) and duplicated texts (use exact or role).

## Element not found after deploy
The UI changed. Open the step → **Test locator** → pick the new primary. Old primary stays as an alternative for healing evidence.

## Test timeout / step timeout
- Long flows: raise test \`timeoutMs\`.
- Slow pages: step \`timeoutMs\` extends \`expect()\` polling too (fixed in this version — previously it only capped the step wrapper).
- Flaky dropdowns: small \`waitForTimeout\` after fill + exact option text.

## WS: reconnecting…
Events are informational; the page refetches authoritative DB state on reconnect. Refresh if a run looks stuck — a terminal run in the DB is the truth.

## Unsupported Media Type on Start run (fixed)
Was a duplicate \`Content-Type\` header bug in the web client — fixed. If you see it again, report the exact request from DevTools Network.

## Order blocked: unpaid orders warning
Staging guard: the account cannot place new orders while old ones are unpaid. Cancel them (account → Orders → Hủy, or admin) before re-running purchase tests — each purchase run places one real staging order.

## Assert fails right after submit — think validation first, locator second
If fills + submit all pass but the landing assertion times out, the app probably never navigated: open the screenshot and look for a red validation line. Real pilot cases: re-registering with a used email/phone ("đã được sử dụng" — register enforces unique email **and** phone), and logging in with a wrong password (the app reloads an empty form). No wait or locator tweak fixes these — fresh data does.

## Deleted data that is not really gone
Some apps soft-delete: the row vanishes from the list but the unique key stays reserved (our demo-print users keep their email forever — no trash UI, no force delete). Design suites around it: one permanent test account per flow, documented in variables, not create/delete cycles.

## Login then goto immediately after click
A \`goto\` fired right after the Login click can abort the in-flight login POST — the next page loads logged-out and everything downstream fails mysteriously. Pattern: always assert the landing (title or heading) after login before navigating further.

## Popup tabs and JS confirms
- Link with \`target=_blank\` (e.g. an Edit link): the runner stays on the original page — \`goto\` the edit URL directly instead of clicking.
- SweetAlert-style confirms are DOM, not native dialogs: click the delete link, then click \`.swal2-confirm\`. (Native \`confirm()\` would use the \`handleDialog\` step instead.)`,
  },
  {
    id: "roles",
    group: "Reference",
    title: "Roles (viewer / editor / owner)",
    body: `## Project roles
| Role | Can |
|---|---|
| viewer | Read everything, write nothing |
| editor | Create/edit/run everything except project deletes |
| owner | All of editor + delete project |

Global \`admin\` bypasses membership; global \`viewer\` is read-only everywhere.

## 403 vs 409
- **403** — no access: not a member, or role too low (\`Requires project role 'editor'…\`). Ask an owner for membership or a higher role.
- **409** — conflict with live state: deleting a test/suite/project with queued/running runs (cancel them first), or a duplicate name. Fix the conflict, retry.`,
  },
];

/** Minimal markdown renderer (headings, lists, bold, code, quotes, fences, tables). */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) {
      return <strong key={`${keyPrefix}-${i}`}>{p.slice(2, -2)}</strong>;
    }
    if (p.startsWith("`") && p.endsWith("`")) {
      return (
        <code key={`${keyPrefix}-${i}`} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12.5px] text-slate-800">
          {p.slice(1, -1)}
        </code>
      );
    }
    return <span key={`${keyPrefix}-${i}`}>{p}</span>;
  });
}

function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const lines = text.split("\n");
    const out: React.ReactNode[] = [];
    let list: string[] | null = null;
    let ordered: string[] | null = null;
    let fence: string[] | null = null;
    let quote: string[] | null = null;
    let table: string[][] | null = null;
    let k = 0;
    const flush = () => {
      if (list) {
        out.push(
          <ul key={k++} className="mb-3 list-disc space-y-1 pl-5 text-sm leading-relaxed text-slate-700">
            {list.map((li, i) => (
              <li key={i}>{renderInline(li, `ul-${k}-${i}`)}</li>
            ))}
          </ul>,
        );
        list = null;
      }
      if (ordered) {
        out.push(
          <ol key={k++} className="mb-3 list-decimal space-y-1 pl-5 text-sm leading-relaxed text-slate-700">
            {ordered.map((li, i) => (
              <li key={i}>{renderInline(li, `ol-${k}-${i}`)}</li>
            ))}
          </ol>,
        );
        ordered = null;
      }
      if (fence) {
        out.push(
          <pre key={k++} className="mb-3 overflow-x-auto rounded-md border border-slate-200 bg-slate-900 p-3 font-mono text-xs text-slate-100">
            {fence.join("\n")}
          </pre>,
        );
        fence = null;
      }
      if (quote) {
        out.push(
          <blockquote key={k++} className="mb-3 rounded-r-md border-l-4 border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {quote.map((q, i) => (
              <p key={i}>{renderInline(q, `q-${k}-${i}`)}</p>
            ))}
          </blockquote>,
        );
        quote = null;
      }
      if (table) {
        const [head, ...rows] = table;
        out.push(
          <div key={k++} className="mb-3 overflow-x-auto rounded-md border border-slate-200">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50">
                  {head.map((c, i) => (
                    <th key={i} className="border-b border-slate-200 px-3 py-2 text-left font-semibold text-slate-800">
                      {renderInline(c, `th-${k}-${i}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={i % 2 ? "bg-slate-50/50" : "bg-white"}>
                    {r.map((c, j) => (
                      <td key={j} className="border-t border-slate-100 px-3 py-2 text-slate-700">
                        {renderInline(c, `td-${k}-${i}-${j}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
        table = null;
      }
    };
    for (const line of lines) {
      if (line.startsWith("```")) {
        if (fence) flush();
        else { flush(); fence = []; }
        continue;
      }
      if (fence) { fence.push(line); continue; }
      if (/^\|.*\|\s*$/.test(line) && line.includes("|")) {
        const cells = line.split("|").slice(1, -1).map((c) => c.trim());
        if (/^:?-+:?$/.test(cells[0] ?? "") && cells.every((c) => /^:?-+:?$/.test(c))) continue; // separator row
        (table ??= []).push(cells);
        list = null; ordered = null; quote = null;
        continue;
      }
      if (line.startsWith("> ")) { (quote ??= []).push(line.slice(2)); continue; }
      if (/^##\s/.test(line)) { flush(); out.push(<h2 key={k++} className="mb-2 mt-4 text-base font-semibold text-slate-900 first:mt-0">{renderInline(line.slice(3), `h-${k}`)}</h2>); continue; }
      const ol = line.match(/^\d+\.\s+(.*)/);
      if (ol) { (ordered ??= []).push(ol[1]); list = null; quote = null; continue; }
      if (/^-\s/.test(line)) { (list ??= []).push(line.slice(2)); ordered = null; quote = null; continue; }
      flush();
      if (line.trim() === "") continue;
      out.push(<p key={k++} className="mb-2.5 text-sm leading-relaxed text-slate-700">{renderInline(line, `p-${k}`)}</p>);
    }
    flush();
    return out;
  }, [text]);
  return <>{blocks}</>;
}

/** /docs — user guide with sidebar navigation (standard docs layout). */
export function DocsPage() {
  const [active, setActive] = useState<string>("quickstart");
  const groups = useMemo(() => {
    const g: Array<{ name: string; items: DocSection[] }> = [];
    for (const s of SECTIONS) {
      const found = g.find((x) => x.name === s.group);
      if (found) found.items.push(s);
      else g.push({ name: s.group, items: [s] });
    }
    return g;
  }, []);
  const current = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0];
  return (
    <main className="mx-auto max-w-6xl p-6">
      <p className="mb-3 text-sm text-slate-500">
        <Link to="/projects" className="hover:text-slate-800 hover:underline">Projects</Link>
        <span aria-hidden> / </span> Documentation
      </p>
      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <aside className="md:sticky md:top-20 md:self-start">
          <nav aria-label="Documentation sections" className="space-y-4 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
            {groups.map((g) => (
              <div key={g.name}>
                <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{g.name}</p>
                <ul className="space-y-0.5">
                  {g.items.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => setActive(s.id)}
                        aria-current={s.id === active ? "page" : undefined}
                        className={`w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                          s.id === active
                            ? "bg-indigo-50 font-semibold text-indigo-700"
                            : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                        }`}
                      >
                        {s.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>
        <article className="min-w-0 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="mb-4 border-b border-slate-100 pb-3 text-xl font-bold text-slate-900">{current.title}</h1>
          <Markdown text={current.body} />
          <div className="mt-6 flex justify-between border-t border-slate-100 pt-3">
            {(() => {
              const i = SECTIONS.indexOf(current);
              const prev = SECTIONS[i - 1];
              const next = SECTIONS[i + 1];
              return (
                <>
                  {prev ? (
                    <button type="button" onClick={() => setActive(prev.id)} className="text-sm text-indigo-700 hover:underline">← {prev.title}</button>
                  ) : <span />}
                  {next ? (
                    <button type="button" onClick={() => setActive(next.id)} className="text-sm text-indigo-700 hover:underline">{next.title} →</button>
                  ) : <span />}
                </>
              );
            })()}
          </div>
        </article>
      </div>
    </main>
  );
}
