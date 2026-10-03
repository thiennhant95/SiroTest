/**
 * P2 AI REST client (mirrors apps/server/src/routes/ai.ts).
 *
 * Base + auth follow apps/web/src/lib/api.ts: VITE_API_BASE/VITE_API_URL,
 * Bearer vv_token with the x-user-id dev fallback the server accepts.
 */
import { ApiError, apiBase, getToken } from "../lib/api";

export type AIEngine = "rules" | "llm";

export interface AiStep {
  id: string;
  type: string;
  name?: string;
  [k: string]: unknown;
}

export interface AiStatus {
  engine: AIEngine;
  provider: string;
  model?: string;
}

export interface NlToStepsResponse {
  engine: AIEngine;
  steps: AiStep[];
  unparsed: string[];
}

export interface FailureExplanation {
  category: "locator-not-found" | "timeout" | "assert-mismatch" | "navigation" | "unknown";
  summary: string;
  likelyCauses: string[];
  suggestedFixes: string[];
  confidence: "low" | "medium" | "high";
}

export interface ExplainResponse {
  engine: AIEngine;
  explanation: FailureExplanation;
}

export interface CleanupChange {
  kind: "merge-fill" | "drop-click-before-fill" | "merge-goto" | "rename" | "suggest-assertion" | "kept-unrecognized";
  description: string;
  stepIds: string[];
  suggestedStep?: AiStep;
}

export interface CleanupResponse {
  engine: AIEngine;
  steps: AiStep[];
  changes: CleanupChange[];
}

export interface ExplainRequest {
  runId?: string;
  stepId?: string;
  errorSummary?: string;
  stepType?: string;
  stepName?: string;
  locator?: Record<string, unknown>;
  timeoutMs?: number;
}

function aiHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const token = getToken();
  if (token) h.Authorization = `Bearer ${token}`;
  else h["x-user-id"] = (import.meta.env?.VITE_API_TOKEN as string | undefined) ?? "dev-user";
  return h;
}

async function aiReq<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { ...aiHeaders(), ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string } & T;
  if (!res.ok) {
    throw new ApiError(body.code ?? "REQUEST_FAILED", body.message ?? `HTTP ${res.status}`, res.status);
  }
  return body as T;
}

export const aiApi = {
  status: () => aiReq<AiStatus>("/ai/status"),
  nlToSteps: (text: string, projectId?: string) =>
    aiReq<NlToStepsResponse>("/ai/nl-to-steps", {
      method: "POST",
      body: JSON.stringify(projectId ? { text, projectId } : { text }),
    }),
  explain: (payload: ExplainRequest) =>
    aiReq<ExplainResponse>("/ai/explain", { method: "POST", body: JSON.stringify(payload) }),
  cleanupBySteps: (steps: unknown[]) =>
    aiReq<CleanupResponse>("/ai/cleanup", { method: "POST", body: JSON.stringify({ steps }) }),
  cleanupByTest: (testId: string) =>
    aiReq<CleanupResponse>("/ai/cleanup", { method: "POST", body: JSON.stringify({ testId }) }),
};
