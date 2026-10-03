/**
 * AssertionPickerModal — flow B (01-product/user-flows.md):
 * Add assertion -> select element -> propose Visible/Hidden/Text
 * equals+contains/Value/Enabled-Disabled/Checked -> enter expected ->
 * insert at the chosen position (before/after anchor step).
 * Acceptance minimum covered: Visible / Text-contains / Value / URL.
 */
import { useCallback, useState } from "react";
import { setPickMode } from "../lib/api";
import { Button, Dialog, Field, Input, Select } from "./ui";
import {
  extractPickedLocator,
  useRecorderEvents,
  wsUrlFromApiBase,
} from "../lib/recorderWs";
import type { LocatorCandidate } from "../lib/locator";
import {
  ASSERTION_OPTIONS,
  type BuilderStep,
} from "../builder/types";
import { FIXTURE_TARGETS, newStepId } from "../builder/sampleSteps";

export type InsertPosition = "before" | "after";

export function AssertionPickerModal(props: {
  open: boolean;
  anchorId: string | null;
  apiBase: string;
  sessionId?: string;
  onInsert: (step: BuilderStep, anchorId: string, position: InsertPosition) => void;
  onClose: () => void;
}): JSX.Element | null {
  const [picked, setPicked] = useState<{
    primary: LocatorCandidate;
    alternatives: LocatorCandidate[];
  } | null>(null);
  const [assertionType, setAssertionType] = useState("assertVisible");
  const [expected, setExpected] = useState("");
  const [position, setPosition] = useState<InsertPosition>("after");
  const [pickError, setPickError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const option = ASSERTION_OPTIONS.find((o) => o.type === assertionType);

  const handleEvent = useCallback((event: string, payload: Record<string, unknown>) => {
    if (event !== "recorder.locatorPicked") return;
    const found = extractPickedLocator(payload);
    if (found) {
      setPicked(found);
      setPicking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRecorderEvents({
    wsUrl: props.open && props.sessionId ? wsUrlFromApiBase(props.apiBase) : null,
    onEvent: handleEvent,
  });

  if (!props.open) return null;

  async function enableAssertionPick(): Promise<void> {
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
        mode: "assertion",
      });
    } catch (e) {
      setPicking(false);
      setPickError(e instanceof Error ? e.message : String(e));
    }
  }

  const canInsert =
    option !== undefined &&
    (!option.needsTarget || picked !== null) &&
    (!option.needsExpected || expected.trim().length > 0) &&
    props.anchorId !== null;

  function insert(): void {
    if (!option || !props.anchorId || !canInsert) return;
    const step: BuilderStep = {
      id: newStepId("assert"),
      type: option.type,
      name: option.label,
      enabled: true,
    };
    if (option.needsTarget && picked) {
      step.target = { primary: picked.primary, alternatives: picked.alternatives };
    }
    if (option.needsExpected) step.expected = expected.trim();
    props.onInsert(step, props.anchorId, position);
    props.onClose();
  }

  return (
    <Dialog open={props.open} onClose={props.onClose} title="Add assertion">
      <div data-testid="assertion-modal" className="space-y-4 px-4 py-4">
        <section className="space-y-2">
          <h4 className="text-sm font-semibold text-slate-700">
            <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-bold text-indigo-700">1</span>
            Select element
          </h4>
          {picked ? (
            <div className="flex items-start justify-between gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2">
              <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-indigo-900">
                {JSON.stringify(picked.primary)}
              </code>
              <Button type="button" size="sm" variant="ghost" onClick={() => setPicked(null)}>
                Clear
              </Button>
            </div>
          ) : (
            <p className="text-[13px] text-slate-500">No element selected.</p>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button type="button" size="sm" variant="outline" onClick={() => void enableAssertionPick()} disabled={picking}>
              {picking ? "Assertion pick ON — click an element…" : "Pick from page"}
            </Button>
            {FIXTURE_TARGETS.map((t) => (
              <Button
                key={t.label}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setPicked({ primary: t.primary, alternatives: t.alternatives })}
              >
                {t.label}
              </Button>
            ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setPicked(null);
                setAssertionType("assertURL");
              }}
            >
              Page URL (no element)
            </Button>
          </div>
          {pickError && (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              {pickError}
            </p>
          )}
        </section>

        <section className="space-y-2">
          <h4 className="text-sm font-semibold text-slate-700">
            <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-bold text-indigo-700">2</span>
            Assertion kind
          </h4>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Assertion kind">
            {ASSERTION_OPTIONS.map((o) => {
              const active = o.type === assertionType;
              return (
                <button
                  key={o.type}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  title={o.hint}
                  disabled={o.needsTarget && !picked}
                  onClick={() => setAssertionType(o.type)}
                  className={`rounded-md border px-2.5 py-1 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    active
                      ? "border-indigo-600 bg-indigo-50 font-semibold text-indigo-700"
                      : "border-slate-300 bg-white text-slate-700 hover:border-indigo-400"
                  }`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          {option && <p className="text-xs text-slate-500">{option.hint}</p>}
        </section>

        {option?.needsExpected && (
          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-slate-700">
              <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-bold text-indigo-700">3</span>
              Expected value
            </h4>
            <Field label="Expected">
              <Input
                value={expected}
                onChange={(e) => setExpected(e.target.value)}
                placeholder={option.expectedPlaceholder ?? "Expected value"}
              />
            </Field>
          </section>
        )}

        <div className="flex items-end justify-between gap-2 border-t border-slate-200 pt-3">
          <Field label={option?.needsExpected ? "4. Insert position" : "3. Insert position"}>
            <Select value={position} onChange={(e) => setPosition(e.target.value as InsertPosition)} className="w-44">
              <option value="before">before selected step</option>
              <option value="after">after selected step</option>
            </Select>
          </Field>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="button" onClick={insert} disabled={!canInsert}>
              Insert assertion
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
