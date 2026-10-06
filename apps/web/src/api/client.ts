import type { RunDetail, TestVersion } from "../types";

/**
 * Minimal REST client for /api/v1 (08-api/api-spec.md).
 * Base URL: VITE_API_URL or same-origin "/api/v1".
 *
 * Security: every request carries the same credential as lib/api.ts
 * (Authorization Bearer vv_token, dev fallback x-user-id) so the server's
 * requireAuth gate cannot be bypassed by using this older client.
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
  // P0 dev fallback: server accepts x-user-id (server auth.ts).
  headers["x-user-id"] =
    (import.meta.env?.VITE_API_TOKEN as string | undefined) ?? "dev-user";
  return headers;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const { headers: initHeaders, ...rest } = init ?? {};
  const method = (rest.method ?? "GET").toUpperCase();
  // Same Fastify empty-body rule as lib/api day6req: bodiless writes send '{}'.
  const body = (rest as { body?: unknown }).body ?? ((method === "POST" || method === "DELETE" || method === "PUT" || method === "PATCH") ? "{}" : undefined);
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    body: body as BodyInit | undefined,
    headers: { ...authHeaders(), ...((initHeaders ?? {}) as Record<string, string>) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body || res.statusText}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/") || ct.includes("typescript")) {
    return (await res.text()) as unknown as T;
  }
  return (await res.json()) as T;
}

export const api = {
  getRun: (id: string) => req<RunDetail>(`/runs/${id}`),
  cancelRun: (id: string) =>
    // NOTE: Fastify rejects `content-type: application/json` with an empty
    // body (400), so bodiless POSTs must send '{}' explicitly.
    req<RunDetail>(`/runs/${id}/cancel`, { method: "POST", body: "{}" }),
  rerun: (testId: string, environmentId: string, browser = "chromium") =>
    req<RunDetail>(`/tests/${testId}/runs`, {
      method: "POST",
      body: JSON.stringify({ environmentId, browser, headed: false }),
    }),
  listRuns: (testId: string) => req<RunDetail[]>(`/tests/${testId}/runs`),

  /** POST compile -> { code } (P1: datasetId previews the data-driven loop). */
  compile: (testId: string, datasetId?: string) =>
    req<{ code: string; testId: string }>(`/tests/${testId}/compile`, {
      method: "POST",
      body: JSON.stringify(datasetId ? { datasetId } : {}),
    }),
  /** GET export?format=spec -> raw .spec.ts text (P1: &datasetId= previews loop). */
  exportSpec: async (testId: string, datasetId?: string): Promise<string> => {
    const qs = datasetId ? `?format=spec&datasetId=${encodeURIComponent(datasetId)}` : "?format=spec";
    const res = await fetch(`${BASE}/tests/${testId}/export${qs}`, {
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    return res.text();
  },

  listVersions: (testId: string) =>
    req<TestVersion[]>(`/tests/${testId}/versions`),
  getTest: (testId: string) =>
    req<{ id: string; name: string; definitionJson: unknown }>(
      `/tests/${testId}`,
    ),
  /** Meaningful save only: caller must pass changeMessage (versioning.md). */
  saveTest: (testId: string, definitionJson: unknown, changeMessage: string) =>
    req<unknown>(`/tests/${testId}`, {
      method: "PATCH",
      body: JSON.stringify({ definitionJson, changeMessage }),
    }),
  restoreVersion: (testId: string, versionId: string) =>
    req<TestVersion>(`/tests/${testId}/versions/${versionId}/restore`, {
      method: "POST",
      body: "{}",
    }),
  deleteTest: (testId: string) =>
    fetch(`${BASE}/tests/${testId}`, { method: "DELETE", headers: authHeaders() }),
};

export function traceViewerUrl(traceUrl: string): string {
  // Open the ORIGINAL Playwright Trace Viewer — never rebuild it (artifacts-reporting.md).
  return `https://trace.playwright.dev/?trace=${encodeURIComponent(traceUrl)}`;
}
