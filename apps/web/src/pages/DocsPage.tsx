import { useState } from "react";

const SECTIONS = [
  {
    id: "quickstart",
    title: "Quickstart",
    body: `1. Log in (Dev tab, e.g. tester-1) or register an account.
2. Projects → + New project (name, optional base URL).
3. Open the project → Tests → + New test, or import a .spec.ts draft.
4. In the Builder, add steps (click, fill, assertions…), pick locators from the page or presets.
5. Press Run, pick an environment + browser, Start run. Watch live progress; review screenshots, video and trace in Evidence.`,
  },
  {
    id: "concepts",
    title: "Core concepts",
    body: `A test is a versioned JSON TestDefinition — the single source of truth. The visual editor and the compiler both operate on JSON; TypeScript is output only.
• Steps run top to bottom, each in an isolated browser context (fresh cookies/storage per run).
• Variables ({{NAME}}) resolve at run time. Secrets are encrypted at rest and redacted in logs, artifacts and API responses.
• Locators execute the stored primary only. Ranked alternatives are evidence for future repair proposals — never silently applied.`,
  },
  {
    id: "run-modes",
    title: "Run modes",
    body: `• Headless (default): fastest, for CI and bulk runs.
• Headed: opens a real Chromium window on the host so you can watch each step.
• Observe closely: headed + 500ms slow-motion + keeps trace/video even on passes — the closest equivalent to Playwright --ui replay.
• Debug: opens the Playwright Inspector on the host (like --debug). Step through manually; the run stays alive until you close the Inspector or press Cancel.
• Viewport override: run the same test at Desktop / Laptop / Tablet / Mobile sizes for responsive checks.
• Heal with alternatives: on locator failure, tries stored alternatives and files a reviewable proposal. The step still fails — nothing is auto-applied.`,
  },
  {
    id: "evidence",
    title: "Evidence (screenshots / video / trace)",
    body: `Every run keeps result.json. Screenshot steps are always persisted. Trace and video are kept on failure by default; tick “Observe closely” to keep them on passes too.
• Screenshots render inline in the run page.
• Video plays inline.
• Trace downloads as trace.zip — open with: npx playwright show-trace trace.zip (or drag into https://trace.playwright.dev).`,
  },
  {
    id: "suites",
    title: "Suites & schedules",
    body: `Suites group tests into one ordered run (sequential or up to 2 parallel, optional retries per test). Schedules trigger a suite or a single test on a cron expression (e.g. 0 7 * * * daily at 07:00). Keep schedules disabled unless the runs are side-effect free — a purchase test places a real order on every run.`,
  },
  {
    id: "api-tests",
    title: "API tests",
    body: `The apiRequest step calls any HTTP API (GET/POST/PUT/PATCH/DELETE) with headers/body templating, explicit expectedStatus, and saveAs to reuse the response later. mockRoute intercepts browser traffic before the app fires it — mock a 500 to verify the UI error path without breaking the backend.`,
  },
  {
    id: "a11y",
    title: "Accessibility & visual checks",
    body: `• axeCheck runs an axe-core scan (WCAG 2.0/2.1 A+AA) and fails listing rule ids (e.g. color-contrast[serious]). Scope with CSS, choose impact levels, skip accepted rules.
• visualCheck diffs against a stored baseline screenshot within a threshold — run once with capture to mint the baseline.`,
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    body: `• “No access to project”: you are logged in as a different user than the project owner — ask for membership or log in as the owner.
• Strict-mode violation: a locator matches 0 or 2+ elements. Prefer role+name, narrow text to exact, or scope XPath to the right container.
• Test timeout: long flows need a higher test timeoutMs; step timeoutMs now extends expect() polling too.
• WS “reconnecting…”: the page refetches authoritative DB state on reconnect — refresh if a run looks stuck.`,
  },
];

/** /docs — in-app user guide (English). */
export function DocsPage() {
  const [open, setOpen] = useState<string>("quickstart");
  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Documentation</h1>
        <p className="mt-1 text-sm text-slate-500">
          Tester guide: concepts, run modes, evidence, suites, API/a11y testing, troubleshooting.
        </p>
      </div>
      <div className="space-y-2">
        {SECTIONS.map((s) => {
          const isOpen = open === s.id;
          return (
            <section key={s.id} className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
              <button
                type="button"
                onClick={() => setOpen(isOpen ? "" : s.id)}
                aria-expanded={isOpen}
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-slate-50"
              >
                <span className="text-sm font-semibold text-slate-800">{s.title}</span>
                <span aria-hidden className="text-slate-400">{isOpen ? "▾" : "▸"}</span>
              </button>
              {isOpen ? (
                <div className="border-t border-slate-100 px-4 py-3">
                  {s.body.split("\n").map((line, i) => (
                    <p key={i} className="mb-1.5 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
                      {line}
                    </p>
                  ))}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </main>
  );
}
