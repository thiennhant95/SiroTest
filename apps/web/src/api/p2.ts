/**
 * P2 REST client: healing proposals + assertion suggestions.
 *
 * Contract (server: apps/server/src/routes/healing.ts, suggestions.ts —
 * register `healingRoutes` + `suggestionRoutes` under `/api/v1` in app.ts):
 *   GET  /tests/:id/healing?status=pending|approved|rejected|all
 *   POST /healing/:pid/approve
 *   POST /healing/:pid/reject
 *   POST /tests/:id/suggestions            { sessionId?, steps? }
 *   POST /tests/:id/suggestions/apply       { suggestionIds | indexes, position? }
 *
 * Auth mirrors api/client.ts (Bearer vv_token, dev fallback x-user-id).
 */

const BASE =
  (import.meta.env?.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ??
  "/api/v1";

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  try {
    const token = localStorage.getItem("vv_token");
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      return headers;
    }
  } catch {
    /* non-browser / private mode */
  }
  headers["x-user-id"] =
    (import.meta.env?.VITE_API_TOKEN as string | undefined) ?? "dev-user";
  return headers;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const { headers: initHeaders, ...rest } = init ?? {};
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    headers: { ...authHeaders(), ...((initHeaders ?? {}) as Record<string, string>) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body || res.statusText}`);
  }
  return (await res.json()) as T;
}

export interface HealingProposal {
  id: string;
  projectId: string;
  testId: string;
  stepId: string;
  runId: string;
  /** JSON string of the failing primary candidate. */
  fromLocator: string;
  /** JSON string of the succeeding alternative candidate. */
  toLocator: string;
  /** JSON string: { tried, matchCount, preview, verified, durationMs, reason }. */
  evidence: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  decidedAt: string | null;
}

export interface SuggestedAssertion {
  id: string;
  stepId: string;
  kind: string;
  afterStepId: string;
  step: Record<string, unknown>;
  reason: string;
  masked?: boolean;
}

export interface ApplyResult {
  testId: string;
  versionNumber: number;
  stepCount: number;
  applied: Array<{ suggestionId: string; stepId: string; afterStepId: string }>;
}

export const p2api = {
  listHealing: (testId: string, status: "pending" | "approved" | "rejected" | "all" = "pending") =>
    req<HealingProposal[]>(`/tests/${testId}/healing?status=${status}`),
  approveHealing: (proposalId: string) =>
    req<{ proposal: HealingProposal; versionNumber: number }>(`/healing/${proposalId}/approve`, { method: "POST" }),
  rejectHealing: (proposalId: string) =>
    req<HealingProposal>(`/healing/${proposalId}/reject`, { method: "POST" }),

  fetchSuggestions: (testId: string, body: { sessionId?: string; steps?: unknown[] } = {}) =>
    req<{ testId: string; source: string; stepCount: number; suggestions: SuggestedAssertion[] }>(
      `/tests/${testId}/suggestions`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  applySuggestions: (
    testId: string,
    body:
      | { suggestionIds: string[]; position?: unknown }
      | { indexes: number[]; position?: unknown },
  ) =>
    req<ApplyResult>(`/tests/${testId}/suggestions/apply`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
