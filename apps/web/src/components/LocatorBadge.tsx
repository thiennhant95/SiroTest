/**
 * LocatorBadge (10-ui-ux/visual-builder.md "Locator UX"):
 * readable target summary first (`Button "Login"`), exact Playwright
 * expression only inside Advanced (via engine toExpression).
 */
import {
  candidateToExpression,
  humanizeLocator,
} from "../lib/locator";
import type { LocatorCandidate } from "../lib/locator";

export function LocatorBadge(props: {
  primary: LocatorCandidate | null | undefined;
  alternatives?: LocatorCandidate[];
  compact?: boolean;
}): JSX.Element {
  const { primary, alternatives } = props;
  if (!primary) {
    return (
      <span
        style={{
          display: "inline-block",
          padding: "2px 8px",
          borderRadius: 999,
          background: "#f1f5f9",
          color: "#64748b",
          fontSize: 12,
        }}
      >
        No locator
      </span>
    );
  }
  return (
    <span style={{ display: "inline-block", maxWidth: "100%" }}>
      <span
        title="Locator target"
        style={{
          display: "inline-block",
          padding: "2px 10px",
          borderRadius: 999,
          background: "#e0f2fe",
          color: "#075985",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {humanizeLocator(primary)}
      </span>
      {!props.compact && (
        <details style={{ marginTop: 4, fontSize: 12 }}>
          <summary style={{ cursor: "pointer", color: "#475569" }}>
            Advanced
          </summary>
          <code
            style={{
              display: "block",
              marginTop: 4,
              padding: "6px 8px",
              background: "#0f172a",
              color: "#e2e8f0",
              borderRadius: 6,
              overflowX: "auto",
              whiteSpace: "pre",
            }}
          >
            {candidateToExpression(primary)}
          </code>
          {alternatives && alternatives.length > 0 && (
            <div style={{ marginTop: 4, color: "#475569" }}>
              <div>Alternatives (stored evidence — P0 never auto-switches):</div>
              <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
                {alternatives.map((alt, i) => (
                  <li key={i}>
                    <code>{candidateToExpression(alt)}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </details>
      )}
    </span>
  );
}
