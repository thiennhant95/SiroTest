/**
 * LocatorTestPanel — "Test locator" UI in the Inspector.
 * Calls POST /api/v1/tests/:id/locator/test (falls back to
 * POST /api/v1/recorder/:sessionId/locator/test), renders 0/1/N +
 * highlight preview. 0 matches -> error blocking healthy save;
 * N matches -> warning unless the step type permits multiple.
 */
import { useState } from "react";
import { testLocator } from "../lib/api";
import {
  candidateToExpression,
  evaluateForSave,
  isMultiAllowed,
} from "../lib/locator";
import type { LocatorCandidate } from "../lib/locator";
import type { StepTestResult } from "../builder/types";

type Phase = "idle" | "testing" | "error";

export function LocatorTestPanel(props: {
  candidate: LocatorCandidate | null | undefined;
  stepType: string;
  apiBase: string;
  testId?: string;
  sessionId?: string;
  onResult?: (r: StepTestResult | null) => void;
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StepTestResult | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  async function run(): Promise<void> {
    if (!props.candidate) return;
    setPhase("testing");
    setError(null);
    try {
      const res = await testLocator({
        apiBase: props.apiBase,
        testId: props.testId || undefined,
        sessionId: props.sessionId || undefined,
        candidate: props.candidate,
      });
      const verdict = evaluateForSave(res.matchCount, props.stepType);
      const out: StepTestResult = {
        matchCount: res.matchCount,
        status:
          res.matchCount === 0
            ? "none"
            : res.matchCount === 1
              ? "unique"
              : "ambiguous",
        canSave: verdict.canSave,
        message: verdict.message,
        warning: verdict.warning,
      };
      setResult(out);
      setPreview(res.preview ?? candidateToExpression(props.candidate));
      props.onResult?.(out);
      setPhase("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  const box =
    result && !error ? (
      <div
        role={result.status === "none" ? "alert" : "status"}
        style={{
          marginTop: 8,
          padding: "8px 10px",
          borderRadius: 6,
          fontSize: 13,
          background:
            result.status === "none"
              ? "#fef2f2"
              : result.status === "unique"
                ? "#f0fdf4"
                : "#fffbeb",
          border: `1px solid ${
            result.status === "none"
              ? "#fecaca"
              : result.status === "unique"
                ? "#bbf7d0"
                : "#fde68a"
          }`,
          color:
            result.status === "none"
              ? "#991b1b"
              : result.status === "unique"
                ? "#166534"
                : "#92400e",
        }}
      >
        <div style={{ fontWeight: 700 }}>
          {result.matchCount === 0 && "0 matches — error"}
          {result.matchCount === 1 && "1 match — unique"}
          {result.matchCount > 1 &&
            (isMultiAllowed(props.stepType)
              ? `${result.matchCount} matches — allowed for ${props.stepType}`
              : `${result.matchCount} matches — warning`)}
        </div>
        <div>{result.message}</div>
        {result.warning && <div>{result.warning}</div>}
        {result.status === "none" && (
          <div style={{ fontWeight: 600 }}>
            Step cannot be saved as healthy — refine the locator.
          </div>
        )}
        {preview && (
          <div style={{ marginTop: 4 }}>
            Highlight preview: <code>{preview}</code>
          </div>
        )}
      </div>
    ) : null;

  return (
    <div>
      <button
        type="button"
        onClick={() => void run()}
        disabled={!props.candidate || phase === "testing"}
        title={
          !props.testId && !props.sessionId
            ? "Set Test ID or Session ID in the Builder toolbar first"
            : "Test locator against the live browser"
        }
      >
        {phase === "testing" ? "Testing…" : "Test locator"}
      </button>
      {error && (
        <div role="alert" style={{ marginTop: 8, color: "#991b1b", fontSize: 13 }}>
          Test failed: {error}
        </div>
      )}
      {box}
    </div>
  );
}
