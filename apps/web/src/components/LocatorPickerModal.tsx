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

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "6px 8px",
  marginTop: 2,
};

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
    <div
      role="dialog"
      aria-label="Pick locator from page"
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
          width: 520,
          maxWidth: "92vw",
          maxHeight: "88vh",
          overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>Pick from page</h3>

        <section style={{ marginBottom: 16 }}>
          <h4 style={{ margin: "0 0 6px" }}>Live browser</h4>
          <p style={{ fontSize: 13, color: "#475569", margin: "0 0 8px" }}>
            {picking
              ? "Pick mode is ON — click any element in the headed recorder browser. The picked locator will fill the Inspector automatically."
              : "Connects to the recorder session and waits for the locatorPicked event."}
          </p>
          <button type="button" onClick={() => void enablePickMode()} disabled={picking}>
            {picking ? "Pick mode ON — click an element…" : "Enable pick mode"}
          </button>{" "}
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 6 }}>
            WS: {wsStatus}
            {rawEvents.length > 0 && ` · last events: ${rawEvents.join(", ")}`}
          </div>
          {pickError && (
            <div role="alert" style={{ color: "#991b1b", fontSize: 13, marginTop: 6 }}>
              {pickError}
            </div>
          )}
        </section>

        <section style={{ marginBottom: 16 }}>
          <h4 style={{ margin: "0 0 6px" }}>Fixture presets (no browser needed)</h4>
          {FIXTURE_TARGETS.map((t) => (
            <button
              key={t.label}
              type="button"
              style={{ marginRight: 8, marginBottom: 8 }}
              onClick={() => {
                props.onPicked({ primary: t.primary, alternatives: t.alternatives });
                props.onClose();
              }}
            >
              {t.label}
            </button>
          ))}
        </section>

        <section>
          <h4 style={{ margin: "0 0 6px" }}>Manual locator</h4>
          <label style={{ fontSize: 13 }}>
            Strategy{" "}
            <select
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
            </select>
          </label>
          {strategy === "role" ? (
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <label style={{ flex: 1, fontSize: 13 }}>
                Role <input style={inputStyle} value={role} onChange={(e) => setRole(e.target.value)} />
              </label>
              <label style={{ flex: 2, fontSize: 13 }}>
                Accessible name{" "}
                <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
              </label>
            </div>
          ) : (
            <label style={{ fontSize: 13 }}>
              Value <input style={inputStyle} value={value} onChange={(e) => setValue(e.target.value)} />
            </label>
          )}
          <div style={{ marginTop: 10 }}>
            <button type="button" onClick={useManual} disabled={!manualValid}>
              Use this locator
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
