/**
 * AssertionPickerModal — flow B (01-product/user-flows.md):
 * Add assertion -> select element -> propose Visible/Hidden/Text
 * equals+contains/Value/Enabled-Disabled/Checked -> enter expected ->
 * insert at the chosen position (before/after anchor step).
 * Acceptance minimum covered: Visible / Text-contains / Value / URL.
 */
import { useCallback, useState } from "react";
import { setPickMode } from "../lib/api";
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
    <div
      role="dialog"
      aria-label="Add assertion"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
      onClick={props.onClose}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 10,
          padding: 20,
          width: 560,
          maxWidth: "94vw",
          maxHeight: "88vh",
          overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>Add assertion</h3>

        <section style={{ marginBottom: 14 }}>
          <h4 style={{ margin: "0 0 6px" }}>1. Select element</h4>
          {picked ? (
            <div style={{ fontSize: 13 }}>
              Target: <strong>{JSON.stringify(picked.primary)}</strong>{" "}
              <button type="button" onClick={() => setPicked(null)}>
                Clear
              </button>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: "#475569" }}>No element selected.</div>
          )}
          <div style={{ marginTop: 6 }}>
            <button type="button" onClick={() => void enableAssertionPick()} disabled={picking}>
              {picking ? "Assertion pick ON — click an element…" : "Pick from page"}
            </button>{" "}
            {FIXTURE_TARGETS.map((t) => (
              <button
                key={t.label}
                type="button"
                style={{ marginRight: 6, marginBottom: 6 }}
                onClick={() => setPicked({ primary: t.primary, alternatives: t.alternatives })}
              >
                {t.label}
              </button>
            ))}
            <button
              type="button"
              style={{ marginBottom: 6 }}
              onClick={() => {
                setPicked(null);
                setAssertionType("assertURL");
              }}
            >
              Page URL (no element)
            </button>
          </div>
          {pickError && (
            <div role="alert" style={{ color: "#991b1b", fontSize: 13, marginTop: 6 }}>
              {pickError}
            </div>
          )}
        </section>

        <section style={{ marginBottom: 14 }}>
          <h4 style={{ margin: "0 0 6px" }}>2. Assertion kind</h4>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {ASSERTION_OPTIONS.map((o) => (
              <button
                key={o.type}
                type="button"
                title={o.hint}
                disabled={o.needsTarget && !picked}
                onClick={() => setAssertionType(o.type)}
                style={{
                  fontWeight: o.type === assertionType ? 700 : 400,
                  outline: o.type === assertionType ? "2px solid #0284c7" : undefined,
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
          {option && (
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>{option.hint}</div>
          )}
        </section>

        {option?.needsExpected && (
          <section style={{ marginBottom: 14 }}>
            <h4 style={{ margin: "0 0 6px" }}>3. Expected value</h4>
            <input
              style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px" }}
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
              placeholder={option.expectedPlaceholder ?? "Expected value"}
            />
          </section>
        )}

        <section style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13 }}>
            {option?.needsExpected ? "4. " : "3. "}Insert
          </span>
          <select value={position} onChange={(e) => setPosition(e.target.value as InsertPosition)}>
            <option value="before">before selected step</option>
            <option value="after">after selected step</option>
          </select>
          <button type="button" onClick={insert} disabled={!canInsert}>
            Insert assertion
          </button>
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
        </section>
      </div>
    </div>
  );
}
