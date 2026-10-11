import { useEffect, useState } from "react";
import { Button } from "./ui";

interface TourStop {
  target: string;
  title: string;
  body: string;
}

interface TourProps {
  stops: TourStop[];
  flag: string;
  label: string;
}

const BUILDER_STOPS: TourStop[] = [
  {
    target: '[data-tour="record"]',
    title: "Record",
    body: "Fastest way to start: drive the app in a real browser and steps appear. Clean names, drop noise, add an assertion, then run.",
  },
  {
    target: '[data-tour="steps"]',
    title: "Steps list",
    body: "Your test, top to bottom. Click a step to edit it, drag to reorder, hover for duplicate / delete. Numbers show execution order.",
  },
  {
    target: '[data-tour="add-step"]',
    title: "Add step",
    body: "Search plain words — click, fill, assert, api. Then pick the locator: role+name first, placeholder for inputs.",
  },
  {
    target: '[data-tour="inspector"]',
    title: "Inspector",
    body: "Edit the selected step here: locator, values with {{VARIABLES}}, timeouts. Test locator reports 0/1/N matches live.",
  },
  {
    target: '[data-tour="stability"]',
    title: "Stability + rubric",
    body: "Rubric scores the recording 0–100 before you spend runs. Check 3× runs the gate — Stable 3/3 certifies this exact definition. Any edit clears it.",
  },
  {
    target: '[data-tour="run"]',
    title: "Run",
    body: "Pick environment + browser and start. Headed shows the browser; Observe closely keeps trace/video; Debug opens the Inspector.",
  },
  {
    target: '[data-tour="tabs"]',
    title: "Bottom tabs",
    body: "Variables holds {{BASE_URL}} and secrets. Gherkin writes steps in Vietnamese. Suggest proposes assertions. Datasets drive rows. Runs lists history. Code shows the generated spec (read-only).",
  },
];

const RUN_STOPS: TourStop[] = [
  {
    target: '[data-tour="run-timeline"]',
    title: "Step timeline",
    body: "Every step with status and time. Failed steps open with the concise error — switch to Developer role for the raw technical details.",
  },
  {
    target: '[data-tour="run-evidence"]',
    title: "Evidence",
    body: "Failure screenshots, video and the Playwright trace. Open the trace in the native viewer to see exactly what the page looked like.",
  },
  {
    target: '[data-tour="run-bug"]',
    title: "Report bug",
    body: "One click builds a Markdown report (summary, error, failed steps, artifacts) — download it or file straight to Jira/Backlog/Slack/Lark.",
  },
];

const BUILDER_V2_FLAG = "vv-tour-builder-v2";
const RUN_FLAG = "vv-tour-run-done";

/** First-run guided tour (spotlight + tooltip, no deps). */
function Tour({ stops, flag, label }: TourProps) {
  const [index, setIndex] = useState<number | null>(() => {
    try {
      return localStorage.getItem(flag) ? null : 0;
    } catch {
      return null;
    }
  });
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (index === null) return;
    const update = () => {
      const el = document.querySelector(stop.target);
      if (el) {
        el.scrollIntoView({ block: "nearest" });
        setRect(el.getBoundingClientRect());
      } else {
        setRect(null);
      }
    };
    update();
    window.addEventListener("resize", update);
    const t = setTimeout(update, 400);
    return () => {
      window.removeEventListener("resize", update);
      clearTimeout(t);
    };
  }, [index]);

  if (index === null) return null;
  const stop = stops[index]!;
  const done = (skip = false) => {
    try {
      localStorage.setItem(flag, skip ? "skipped" : "done");
    } catch {
      /* ignore */
    }
    setIndex(null);
  };

  const boxStyle: React.CSSProperties = rect
    ? {
        position: "fixed",
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 330)),
        top: Math.min(rect.bottom + 10, window.innerHeight - 190),
        width: 320,
        zIndex: 60,
      }
    : { position: "fixed", left: "50%", top: 80, transform: "translateX(-50%)", width: 320, zIndex: 60 };

  return (
    <>
      {rect ? (
        <div
          aria-hidden
          className="fixed z-50 rounded-lg ring-2 ring-indigo-500 ring-offset-2"
          style={{ left: rect.left - 3, top: rect.top - 3 + window.scrollY * 0, width: rect.width + 6, height: rect.height + 6, pointerEvents: "none" }}
        />
      ) : null}
      <div className="fixed inset-0 z-50 bg-slate-900/30" onClick={() => done(true)} aria-hidden />
      <div role="dialog" aria-label={`Tour: ${stop.title}`} className="rounded-lg border border-slate-200 bg-white p-4 shadow-xl" style={boxStyle}>
        <p className="text-xs font-medium text-slate-400">
          {label} · {index + 1}/{stops.length}
        </p>
        <h3 className="mt-1 text-sm font-bold text-slate-900">{stop.title}</h3>
        <p className="mt-1 text-sm text-slate-600">{stop.body}</p>
        <div className="mt-3 flex items-center justify-between">
          <button type="button" className="text-xs text-slate-500 hover:underline" onClick={() => done(true)}>
            Skip tour
          </button>
          <div className="flex gap-2">
            {index > 0 ? (
              <Button type="button" size="sm" variant="outline" onClick={() => setIndex(index - 1)}>
                Back
              </Button>
            ) : null}
            {index < stops.length - 1 ? (
              <Button type="button" size="sm" onClick={() => setIndex(index + 1)}>
                Next
              </Button>
            ) : (
              <Button type="button" size="sm" onClick={() => done()}>
                Got it
              </Button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** Builder tour (7 stops: record → steps → run → tabs). */
export function BuilderTour() {
  return <Tour stops={BUILDER_STOPS} flag={BUILDER_V2_FLAG} label="Builder tour" />;
}

/** Run-result tour (3 stops: timeline → evidence → bug report). */
export function RunTour() {
  return <Tour stops={RUN_STOPS} flag={RUN_FLAG} label="Run result tour" />;
}

function restartTour(flag: string) {
  try {
    localStorage.removeItem(flag);
  } catch {
    /* ignore */
  }
  window.location.reload();
}

/** Re-open the Builder tour from a help button. */
export function restartBuilderTour() {
  restartTour(BUILDER_V2_FLAG);
}

/** Re-open the run-result tour from a help button. */
export function restartRunTour() {
  restartTour(RUN_FLAG);
}
