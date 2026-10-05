/** Minimal cron hint + next-run preview (client-side, no dependency). */

export function validateCron(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "Cron needs exactly 5 fields: minute hour day month weekday (e.g. 0 9 * * 1-5).";
  const [min, hour, dom, mon, dow] = parts;
  if (!fieldOk(min)) return "Minute field (0-59, *, lists/ranges/steps) is invalid.";
  if (!fieldOk(hour)) return "Hour field (0-23) is invalid.";
  if (!fieldOk(dom)) return "Day field (1-31) is invalid.";
  if (!fieldOk(mon)) return "Month field (1-12) is invalid.";
  if (!fieldOk(dow)) return "Weekday field (0-7, 0/7 = Sunday) is invalid.";
  return null;
}

function fieldOk(field: string): boolean {
  if (field === "*") return true;
  return field.split(",").every((seg) => {
    const [range, step] = seg.split("/");
    if (step !== undefined && !/^\d+$/.test(step)) return false;
    if (range === "*") return true;
    if (/^\d+$/.test(range)) return true;
    return /^(\d+)-(\d+)$/.test(range);
  });
}

function matches(field: string, value: number): boolean {
  if (field === "*") return true;
  return field.split(",").some((seg) => {
    const [range, stepStr] = seg.split("/");
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step <= 0) return false;
    if (range === "*") return value % step === 0;
    if (/^\d+$/.test(range)) return Number(range) === value;
    const m = range.match(/^(\d+)-(\d+)$/);
    if (!m) return false;
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (value < lo || value > hi) return false;
    return (value - lo) % step === 0;
  });
}

/**
 * Next-run preview: scans minute-by-minute up to 8 days and returns the
 * first matching Date, or null. Good enough as a tester-readable hint
 * (server remains the authority for actual triggering).
 */
export function previewNextRun(cron: string, from = new Date()): Date | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  if (validateCron(cron) !== null) return null;
  const [minF, hourF, domF, monF, dowF] = parts as [string, string, string, string, string];
  const cursor = new Date(from.getTime() + 60_000);
  cursor.setSeconds(0, 0);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    const d = new Date(cursor.getTime() + i * 60_000);
    const dow = d.getDay();
    const dowMatch = matches(dowF, dow) || (dow === 0 && matches(dowF, 7));
    if (
      matches(minF, d.getMinutes()) &&
      matches(hourF, d.getHours()) &&
      matches(domF, d.getDate()) &&
      matches(monF, d.getMonth() + 1) &&
      dowMatch
    ) {
      return d;
    }
  }
  return null;
}

export const CRON_HINT =
  "5 fields: minute hour day month weekday — e.g. “0 9 * * 1-5” = 9:00 AM Mon–Fri; “*/15 * * * *” = every 15 minutes.";
