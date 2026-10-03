/**
 * LocatorPickerModal — "Pick from page" (Day 5).
 *
 * Live mode: POST /recorder/:sessionId/locator/pick, then the tester clicks
 * an element in the headed browser; the `recorder.locatorPicked` WS event
 * fills primary + alternatives into the Inspector via onPicked.
 * Fixture mode (no live browser): preset targets or a manual strategy form,
 * so the picker flow is testable against the sample fixture app.
 */
import { useCallback, useState } from "react";
import { setPickMode } from "../lib/api";
import { Button, Dialog, Field, Input, Select } from "./ui";
import {
  extractPickedLocator,
  useRecorderEvents,
  wsUrlFromApiBase,
  type PickedLocator,
} from "../lib/recorderWs";
import type { LocatorCandidate } from "../lib/locator";
import { FIXTURE_TARGETS } from "../builder/sampleSteps";

type Strategy = LocatorCandidate["strategy"];

function deriveAlternatives(primary: LocatorCandidate): LocatorCandidate[] {
  // Mirrors engine priority (role+name > label > placeholder > testId >
  // text > css > xpath): keep the next-best stable hooks as evidence.
  switch (primary.strategy) {
    case "role":
      return primary.name
        ? [{ strategy: "text", value: primary.name }]
        : [];
    case "label":
      return [{ strategy: "text", value: primary.value }];
    case "placeholder":
      return [{ strategy: "text", value: primary.value }];
    case "testId":
      return [{ strategy: "css", value: `[data-testid="${primary.value}"]` }];
    default:
      return [];
  }
}

export function LocatorPickerModal(props: {
  open: boolean;
  apiBase: string;
  sessionId?: string;
  onPicked: (picked: PickedLocator) => void;
  onClose: () => void;
}): JSX.Element | null {
  const [pickError, setPickError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [rawEvents, setRawEvents] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<Strategy>("role");
  const [role, setRole] = useState("button");
  const [name, setName] = useState("Login");
  const [value, setValue] = useState("");

  const wsUrl = props.sessionId
    ? wsUrlFromApiBase(props.apiBase)
    : null;

  const handleEvent = useCallback(
    (event: string, payload: Record<string, unknown>) => {
      setRawEvents((prev) => [`${event}`, ...prev].slice(0, 5));
      if (event !== "recorder.locatorPicked") return;
      const picked = extractPickedLocator(payload);
      if (picked) {
        setPicking(false);
        props.onPicked(picked);
        props.onClose();
      }
    },
    // onPicked/onClose are stable enough in Builder usage; listen via ref pattern inside hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const { status: wsStatus } = useRecorderEvents({ wsUrl, onEvent: handleEvent });

  if (!props.open) return null;

  async function enablePickMode(): Promise<void> {
    if (!props.sessionId) {
      setPickError("Set Session ID in the Builder toolbar to pick from a live page.");
      return;
    }
    setPickError(null);
    setPicking(true);
    try {
      await setPickMode({
        apiBase: props.apiBase,
        sessionId: props.sessionId,
        mode: "locator",
      });
    } catch (e) {
      setPicking(false);
      setPickError(e instanceof Error ? e.message : String(e));
    }
  }

  function buildManual(): LocatorCandidate {
    switch (strategy) {
      case "role":
        return name.trim()
          ? { strategy: "role", role: role.trim() || "button", name: name.trim() }
          : { strategy: "role", role: role.trim() || "button" };
      case "label":
        return { strategy: "label", value: value.trim() };
      case "placeholder":
        return { strategy: "placeholder", value: value.trim() };
      case "testId":
        return { strategy: "testId", value: value.trim() };
      case "text":
        return { strategy: "text", value: value.trim() };
      case "css":
        return { strategy: "css", value: value.trim() };
      case "xpath":
        return { strategy: "xpath", value: value.trim() };
    }
  }

  function useManual(): void {
    const primary = buildManual();
    props.onPicked({ primary, alternatives: deriveAlternatives(primary) });
    props.onClose();
  }

  const manualValid =
    strategy === "role" ? role.trim().length > 0 : value.trim().length > 0;

  return (
    <Dialog open={props.open} onClose={props.onClose} title="Pick from page">
      <div className="space-y-4 px-4 py-4">
        <section className="space-y-2">
          <h4 className="text-sm font-semibold text-slate-700">
            <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-bold text-indigo-700">1</span>
            Live browser
          </h4>
          <p className="text-[13px] text-slate-500">
            {picking
              ? "Pick mode is ON — click any element in the headed recorder browser. The picked locator will fill the Inspector automatically."
              : "Connects to the recorder session and waits for the locatorPicked event."}
          </p>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void enablePickMode()} disabled={picking}>
              {picking ? "Pick mode ON — click an element…" : "Enable pick mode"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            WS: {wsStatus}
            {rawEvents.length > 0 && ` · last events: ${rawEvents.join(", ")}`}
          </p>
          {pickError && (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              {pickError}
            </p>
          )}
        </section>

        <section className="space-y-2">
          <h4 className="text-sm font-semibold text-slate-700">
            <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-bold text-indigo-700">2</span>
            Fixture presets <span className="font-normal text-slate-500">(no browser needed)</span>
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {FIXTURE_TARGETS.map((t) => (
              <Button
                key={t.label}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  props.onPicked({ primary: t.primary, alternatives: t.alternatives });
                  props.onClose();
                }}
              >
                {t.label}
              </Button>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <h4 className="text-sm font-semibold text-slate-700">
            <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-bold text-indigo-700">3</span>
            Manual locator
          </h4>
          <Field label="Strategy">
            <Select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as Strategy)}
            >
              <option value="role">role</option>
              <option value="label">label</option>
              <option value="placeholder">placeholder</option>
              <option value="testId">testId</option>
              <option value="text">text</option>
              <option value="css">css</option>
              <option value="xpath">xpath</option>
            </Select>
          </Field>
          {strategy === "role" ? (
            <div className="flex gap-2">
              <Field label="Role">
                <Input value={role} onChange={(e) => setRole(e.target.value)} />
              </Field>
              <div className="flex-[2]">
                <Field label="Accessible name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
              </div>
            </div>
          ) : (
            <Field label="Value">
              <Input value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
          )}
          <div>
            <Button type="button" size="sm" onClick={useManual} disabled={!manualValid}>
              Use this locator
            </Button>
          </div>
        </section>
      </div>
    </Dialog>
  );
}
