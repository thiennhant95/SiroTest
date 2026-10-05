import { useEffect, useState } from "react";
import { Button } from "./ui";

interface TourStop {
  target: string;
  title: string;
  body: string;
}

const STOPS: TourStop[] = [
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
    target: '[data-tour="run"]',
    title: "Run",
    body: "Pick environment + browser and start. Headed shows the browser; Observe closely keeps trace/video; Debug opens the Inspector.",
  },
  {
    target: '[data-tour="tabs"]',
    title: "Variables, runs, code",
    body: "Variables tab holds {{BASE_URL}} and secrets. Runs lists history. Code shows the generated Playwright spec (read-only).",
  },
];

const FLAG = "vv-tour-builder-done";

/** First-run guided tour for the Builder (spotlight + tooltip, no deps). */
export function BuilderTour() {
  const [index, setIndex] = useState<number | null>(() => {
    try {
      return localStorage.getItem(FLAG) ? null : 0;
    } catch {
      return null;
    }
  });
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (index === null) return;
    const update = () => {
      const el = document.querySelector(STOPS[index].target);
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
  const stop = STOPS[index];
  const done = (skip = false) => {
    try {
      localStorage.setItem(FLAG, skip ? "skipped" : "done");
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
          Builder tour · {index + 1}/{STOPS.length}
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
            {index < STOPS.length - 1 ? (
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

/** Re-open the tour from a help button. */
export function restartBuilderTour() {
  try {
    localStorage.removeItem(FLAG);
  } catch {
    /* ignore */
  }
  window.location.reload();
}
