/**
 * StepInspector — per-step editor. Locator-bearing steps expose the readable
 * target summary first (LocatorBadge) with Advanced exact expression;
 * "Pick from page" fills primary + alternatives via LocatorPickerModal;
 * LocatorTestPanel gates healthy save with 0/1/N semantics.
 */
import { useState } from "react";
import { bearsLocator, type BuilderStep, type StepTestResult } from "../builder/types";
import { LocatorBadge } from "./LocatorBadge";
import { LocatorPickerModal } from "./LocatorPickerModal";
import { LocatorTestPanel } from "./LocatorTestPanel";
import type { PickedLocator } from "../lib/recorderWs";

export function StepInspector(props: {
  step: BuilderStep;
  apiBase: string;
  testId?: string;
  sessionId?: string;
  testResult?: StepTestResult | null;
  onChange: (patch: Partial<BuilderStep>) => void;
  onTestResult: (r: StepTestResult | null) => void;
  /** Opens the parent AssertionPickerModal anchored at this step (before/after). */
  onAddAssertion?: () => void;
}): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  const { step } = props;
  const locatorStep = bearsLocator(step.type);

  function applyPicked(picked: PickedLocator): void {
    props.onChange({
      target: { primary: picked.primary, alternatives: picked.alternatives },
    });
    // A new locator invalidates the previous test outcome.
    props.onTestResult(null);
  }

  const blocked = props.testResult && !props.testResult.canSave;

  return (
    <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 12 }}>
      <h3 style={{ margin: "0 0 8px" }}>Inspector — {step.type}</h3>

      {blocked && (
        <div
          role="alert"
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            borderRadius: 6,
            padding: "8px 10px",
            fontSize: 13,
            marginBottom: 8,
          }}
        >
          Locator matches 0 elements — this step cannot be saved as healthy.
        </div>
      )}

      <label style={{ display: "block", fontSize: 13, marginBottom: 8 }}>
        Name{" "}
        <input
          style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px" }}
          value={step.name ?? ""}
          onChange={(e) => props.onChange({ name: e.target.value })}
        />
      </label>

      <label style={{ display: "block", fontSize: 13, marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={step.enabled}
          onChange={(e) => props.onChange({ enabled: e.target.checked })}
        />{" "}
        Enabled
      </label>

      {locatorStep && (
        <section style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 13, color: "#475569", marginBottom: 4 }}>Target</div>
          <LocatorBadge
            primary={step.target?.primary}
            alternatives={step.target?.alternatives}
          />
          <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={() => setPickerOpen(true)}>
              Pick from page
            </button>
            {props.onAddAssertion && (
              <button type="button" onClick={props.onAddAssertion}>
                Add assertion
              </button>
            )}
          </div>
          <div style={{ marginTop: 8 }}>
            <LocatorTestPanel
              candidate={step.target?.primary}
              stepType={step.type}
              apiBase={props.apiBase}
              testId={props.testId}
              sessionId={props.sessionId}
              onResult={props.onTestResult}
            />
          </div>
        </section>
      )}

      {(step.type === "fill" || step.type === "select") && (
        <label style={{ display: "block", fontSize: 13, marginBottom: 8 }}>
          Value{" "}
          <input
            style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px" }}
            value={step.value ?? ""}
            onChange={(e) => props.onChange({ value: e.target.value })}
          />
        </label>
      )}
      {step.type.startsWith("assert") && step.expected !== undefined && (
        <label style={{ display: "block", fontSize: 13, marginBottom: 8 }}>
          Expected{" "}
          <input
            style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px" }}
            value={step.expected ?? ""}
            onChange={(e) => props.onChange({ expected: e.target.value })}
          />
        </label>
      )}
      {(step.type === "goto" || step.type === "assertURL") && (
        <label style={{ display: "block", fontSize: 13, marginBottom: 8 }}>
          URL{" "}
          <input
            style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px" }}
            value={step.type === "goto" ? (step.url ?? "") : (step.expected ?? "")}
            onChange={(e) =>
              props.onChange(
                step.type === "goto" ? { url: e.target.value } : { expected: e.target.value },
              )
            }
          />
        </label>
      )}

      <LocatorPickerModal
        open={pickerOpen}
        apiBase={props.apiBase}
        sessionId={props.sessionId}
        onPicked={applyPicked}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}
