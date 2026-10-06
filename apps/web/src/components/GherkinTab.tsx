import { useState } from "react";
import { p2api, type GherkinParseResult } from "../api/p2";
import { api, parseDefinition } from "../lib/api";
import type { BuilderDefinition, BuilderStep } from "../lib/steps";
import { Badge, Button, EmptyState, ErrorState, Field, Textarea, useToast } from "./ui";

/**
 * Agent C — Vietnamese Gherkin tab (deterministic rules parser, no LLM).
 *
 * Flow: tester pastes `Cho rằng/Khi/Thì` text → POST /ai/gherkin → preview
 * parsed steps + explicit unparsed lines → insert appends steps to the end of
 * the current test definition via PATCH /tests/:id (mints a new version like
 * every other save; see BuilderPage autosave / api.saveTest).
 */

const EXAMPLE_PLACEHOLDER = `Kịch bản: Đăng nhập thành công
  Cho rằng mở trang https://test.aloa.asia/admin/login
  Khi nhập "Email Address" là "admin@x.io"
  Và nhập "Password" là "123456"
  Và bấm nút "Sign In"
  Thì kiểm tra "Dashboard" hiển thị`;

export interface GherkinTabProps {
  testId: string;
  projectId?: string;
  onInserted?: () => void;
}

export function GherkinTab({ testId, projectId, onInserted }: GherkinTabProps) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [result, setResult] = useState<GherkinParseResult | null>(null);
  const [parsing, setParsing] = useState(false);
  const [inserting, setInserting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function parse() {
    if (!text.trim()) {
      setError("Paste some Gherkin text first");
      return;
    }
    setParsing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await p2api.parseGherkin(text, projectId || undefined);
      setResult(res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Parse failed";
      setError(msg);
      toast.push("error", msg);
    } finally {
      setParsing(false);
    }
  }

  async function insert() {
    const steps = result?.steps ?? [];
    if (steps.length === 0) {
      setError("Nothing to insert — parse first and check that steps were recognized");
      return;
    }
    setInserting(true);
    setError(null);
    try {
      const record = await api.getTest(testId);
      const parsed = parseDefinition(record.definitionJson) as unknown as BuilderDefinition;
      const existingIds = new Set((parsed.steps ?? []).map((s) => s.id));
      const appended: BuilderStep[] = steps.map((s, i) => {
        let stepId = typeof s.id === "string" && s.id ? s.id : `gherkin-${Date.now().toString(36)}-${i}`;
        while (existingIds.has(stepId)) stepId = `${stepId}-n`;
        existingIds.add(stepId);
        const { id: _drop, ...rest } = s as Record<string, unknown>;
        return { enabled: true, ...rest, id: stepId, type: String(s.type) } as BuilderStep;
      });
      const next: BuilderDefinition = {
        ...parsed,
        steps: [...(parsed.steps ?? []), ...appended],
      };
      await api.saveTest(testId, next as never, `Insert ${appended.length} step(s) from Gherkin`);
      const msg = `Inserted ${appended.length} step(s) at the end of the test.`;
      setNotice(msg);
      toast.push("success", msg);
      onInserted?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Insert failed";
      setError(msg);
      toast.push("error", msg);
    } finally {
      setInserting(false);
    }
  }

  const steps = result?.steps ?? [];
  const unparsed = result?.unparsed ?? [];
  const warnings = result?.warnings ?? [];

  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>Vietnamese Gherkin</strong>
        {result ? (
          <span style={{ display: "inline-flex", gap: 4 }}>
            <Badge tone="slate">{result.engine}</Badge>
            {result.scenarioName ? <Badge tone="indigo">{result.scenarioName}</Badge> : null}
            {result.tags.map((t) => (
              <Badge key={t} tone="slate">#{t}</Badge>
            ))}
          </span>
        ) : null}
      </div>
      <p style={{ fontSize: 12, color: "#666" }}>
        Write Cho rằng / Khi / Thì steps, parse them with deterministic rules (no AI), then insert.
      </p>
      <Field label="Gherkin text (Tiếng Việt)">
        <Textarea
          aria-label="Gherkin text"
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={EXAMPLE_PLACEHOLDER}
        />
      </Field>
      <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
        <Button size="sm" disabled={parsing || !text.trim()} onClick={() => void parse()}>
          {parsing ? "Parsing…" : "Parse"}
        </Button>
        {steps.length > 0 ? (
          <Button size="sm" variant="outline" disabled={inserting} onClick={() => void insert()}>
            {inserting ? "Inserting…" : `Insert ${steps.length} step(s) at end of test`}
          </Button>
        ) : null}
      </div>
      {error ? (
        <div style={{ marginTop: 8 }}>
          <ErrorState message={error} onRetry={parse} />
        </div>
      ) : null}
      {notice && <p style={{ color: "green" }}>{notice}</p>}
      {result && !error ? (
        <div style={{ marginTop: 8 }}>
          {steps.length === 0 ? (
            <EmptyState
              title="No steps recognized"
              hint="Check the unparsed lines below — the parser never invents steps."
            />
          ) : (
            <ul style={{ listStyle: "none", padding: 0 }}>
              {steps.map((s) => (
                <li key={s.id} style={{ marginBottom: 6, fontSize: 13 }}>
                  <code style={{ fontFamily: "monospace" }}>{s.id}</code>{" "}
                  <code>{s.type}</code>{" "}
                  <span style={{ color: "#444" }}>{s.name ?? ""}</span>
                </li>
              ))}
            </ul>
          )}
          {unparsed.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <p style={{ fontSize: 12, fontWeight: 600 }}>Unparsed lines</p>
              <ul style={{ listStyle: "none", padding: 0 }}>
                {unparsed.map((line, i) => (
                  <li key={i} style={{ color: "red", fontSize: 12, fontFamily: "monospace" }}>
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {warnings.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <p style={{ fontSize: 12, fontWeight: 600 }}>Warnings</p>
              <ul style={{ listStyle: "none", padding: 0 }}>
                {warnings.map((w, i) => (
                  <li key={i} style={{ color: "#b45309", fontSize: 12 }}>
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
