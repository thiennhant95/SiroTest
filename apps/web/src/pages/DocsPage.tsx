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

> Tip: tick **Observe closely** on important runs to keep trace/video even on passes.`,
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

A locator matching **0** elements cannot be saved as healthy; **2+** matches raise a strict-mode warning — narrow it (exact text, scoped XPath, CSS by name).`,
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
In the Inspector, **Test locator** reports 0/1/N matches live against a recorder session or the test page. Red (0) blocks saving as healthy.`,
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

> Warning: Debug runs stay \`running\` until you close the Inspector or press **Cancel**. Never schedule headed/debug runs.`,
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

…or drag the file into https://trace.playwright.dev. The trace shows every action, DOM snapshot, network call and console line — it is the single best debugging artifact for a red run.`,
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

Create them in **Schedules** (suite or test + environment + cron). Keep the switch **disabled** until the target is side-effect free, and never schedule headed/debug runs.`,
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
    title: "Responsive testing",
    body: `## Workflow
1. Open the Run dialog → **Viewport** → pick Mobile 375×667 (or 390×844, Tablet 768×1024…).
2. Keep \`screenshot\` steps (or \`visualCheck\` baselines per size) in the test.
3. Compare: same flow, three widths. Broken layout, missing buttons and overflow show up as diffs or failed \`assertVisible\` steps.

## What the machine can and cannot do
- CAN: prove nothing changed vs baseline; prove key elements stay visible at every width.
- CANNOT: judge aesthetics or tap-target comfort — a human reviews the screenshots.

Combine with \`axeCheck\` (contrast, labels) for an objective responsive pass.`,
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
Staging guard: the account cannot place new orders while old ones are unpaid. Cancel them (account → Orders → Hủy, or admin) before re-running purchase tests — each purchase run places one real staging order.`,
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
