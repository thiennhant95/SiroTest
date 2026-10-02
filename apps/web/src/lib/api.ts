/**
 * Builder API client (Day 5-6).
 *
 * Test-locator contract:
 *   POST /api/v1/tests/:id/locator/test      { candidate } -> { matches, preview, healthy }
 *   POST /api/v1/recorder/:sessionId/locator/test  (same shape, exists in P0 server)
 * Client prefers the tests/:id variant and falls back to the recorder-session
 * variant when the former 404s (P0 server only implements the latter).
 *
 * Pick-mode contract (recorder.ts):
 *   POST /api/v1/recorder/:sessionId/locator/pick
 *   POST /api/v1/recorder/:sessionId/assertion/pick
 *   -> session; picked element arrives over WS as `recorder.locatorPicked`.
 */

export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  try {
    const token = localStorage.getItem("vv_token");
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    /* non-browser / private mode */
  }
  return headers;
}

export interface TestLocatorResponse {
  matchCount: number;
  preview?: string;
  healthy?: boolean;
  /** Which endpoint variant answered (for debugging). */
  endpoint: string;
}

function normalizeTestBody(
  body: Record<string, unknown>,
  endpoint: string,
): TestLocatorResponse {
  const raw =
    typeof body.matches === "number"
      ? body.matches
      : typeof body.matchCount === "number"
        ? body.matchCount
        : 0;
  return {
    matchCount: raw,
    preview: typeof body.preview === "string" ? body.preview : undefined,
    healthy: typeof body.healthy === "boolean" ? body.healthy : undefined,
    endpoint,
  };
}

export async function testLocator(opts: {
  apiBase: string;
  testId?: string;
  sessionId?: string;
  candidate: unknown;
}): Promise<TestLocatorResponse> {
  const base = opts.apiBase.replace(/\/$/, "");
  const tried: string[] = [];

  if (opts.testId) {
    try {
      const res = await fetch(
        `${base}/api/v1/tests/${opts.testId}/locator/test`,
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ candidate: opts.candidate }),
        },
      );
      if (res.ok) {
        return normalizeTestBody(
          (await res.json()) as Record<string, unknown>,
          `tests/${opts.testId}/locator/test`,
        );
      }
      if (res.status !== 404) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      tried.push("tests/:id/locator/test -> 404");
    } catch (e) {
      tried.push(`tests/:id/locator/test -> ${String(e)}`);
    }
  }

  if (!opts.sessionId) {
    throw new Error(
      `No recorder session configured. ${tried.join("; ") || "Set Test ID or Session ID in the Builder toolbar."}`,
    );
  }
  const res = await fetch(
    `${base}/api/v1/recorder/${opts.sessionId}/locator/test`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ candidate: opts.candidate }),
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return normalizeTestBody(
    (await res.json()) as Record<string, unknown>,
    `recorder/${opts.sessionId}/locator/test`,
  );
}

export type PickMode = "locator" | "assertion";

export async function setPickMode(opts: {
  apiBase: string;
  sessionId: string;
  mode: PickMode;
}): Promise<void> {
  const base = opts.apiBase.replace(/\/$/, "");
  const res = await fetch(
    `${base}/api/v1/recorder/${opts.sessionId}/${opts.mode}/pick`,
    { method: "POST", headers: authHeaders() },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
}

/* ------------------------------------------------------------------ */
/* Day 6 — Variables/Environments + Run controls (08-api/api-spec.md)  */
/* Appended alongside the Day 5 locator client above; no conflict.     */
/* ------------------------------------------------------------------ */

const API_BASE =
  ((import.meta.env.VITE_API_BASE as string | undefined) ??
    (import.meta.env.VITE_API_URL as string | undefined) ??
    "http://localhost:3001/api/v1").replace(/\/$/, "");

function day6Headers(): Record<string, string> {
  const h = authHeaders();
  if (!h.Authorization) {
    // P0 dev fallback: server accepts x-user-id (auth.ts). Never overrides
    // a real token set by the login flow (vv_token).
    const dev =
      (import.meta.env.VITE_API_TOKEN as string | undefined) || "dev-user";
    return { ...h, "x-user-id": dev };
  }
  return h;
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function day6req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...day6Headers(),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/") || ct.includes("typescript")) {
    const text = (await res.text()) as unknown as T;
    if (!res.ok) throw new ApiError("REQUEST_FAILED", String(text).slice(0, 300), res.status);
    return text;
  }
  const body = (await res.json().catch(() => ({}))) as {
    code?: string;
    message?: string;
  } & T;
  if (!res.ok) {
    throw new ApiError(
      body.code ?? "REQUEST_FAILED",
      body.message ?? `HTTP ${res.status}`,
      res.status,
    );
  }
  return body as T;
}

/** Persist auth token for authHeaders() (login flow). */
export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem("vv_token", token);
    else localStorage.removeItem("vv_token");
  } catch {
    /* non-browser / private mode */
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem("vv_token");
  } catch {
    return null;
  }
}

/** Parse definitionJson (object or JSON string) without mutating. */
export function parseDefinition(input: unknown): unknown {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return input;
    }
  }
  return input;
}

export interface ProjectRecord {
  id: string;
  name: string;
  description?: string | null;
}
export interface TestRecord {
  id: string;
  projectId?: string;
  name: string;
}

export const api = {
  get: <T>(path: string) => day6req<T>(path),
  post: <T>(path: string, data?: unknown) =>
    day6req<T>(path, { method: "POST", body: JSON.stringify(data ?? {}) }),
  patch: <T>(path: string, data: unknown) =>
    day6req<T>(path, { method: "PATCH", body: JSON.stringify(data) }),
  del: (path: string) => day6req<void>(path, { method: "DELETE" }),

  /* Compat helpers used by pages/Projects + ProjectTests (Day 5/7 shell). */
  listProjects: () => day6req<ProjectRecord[]>("/projects"),
  listTests: (projectId: string) =>
    day6req<TestRecord[]>(`/projects/${projectId}/tests`),
  createTest: (projectId: string, name: string) =>
    day6req<TestRecord>(`/projects/${projectId}/tests`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  /* Builder / runs / versions / recorder (used by BuilderPage + RecordPage + RunPage). */
  getTest: (id: string) =>
    day6req<{ id: string; projectId: string; name: string; definitionJson: unknown }>(`/tests/${id}`),
  saveTest: (id: string, definitionJson: unknown, changeMessage?: string) =>
    day6req<unknown>(`/tests/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ definitionJson, ...(changeMessage ? { changeMessage } : {}) }),
    }),
  listEnvironments: (projectId: string) =>
    day6req<Environment[]>(`/projects/${projectId}/environments`),
  listVariables: (projectId: string) =>
    day6req<Variable[]>(`/projects/${projectId}/variables`),
  createRun: (testId: string, opts: { environmentId: string; browser?: string; headed?: boolean }) =>
    day6req<{ id: string; status: string }>(`/tests/${testId}/runs`, {
      method: "POST",
      body: JSON.stringify({ environmentId: opts.environmentId, browser: opts.browser ?? "chromium", headed: opts.headed ?? false }),
    }),
  getRun: (runId: string) => day6req<Run & { steps?: RunStep[] }>(`/runs/${runId}`),
  listRuns: (testId: string) => day6req<{ id: string; status: string; browser: string }[]>(`/tests/${testId}/runs`),
  listVersions: (testId: string) =>
    day6req<{ id: string; versionNumber: number; changeMessage?: string | null }[]>(`/tests/${testId}/versions`),
  recorderStart: (testId: string, baseUrl?: string) =>
    day6req<{ sessionId: string }>(`/tests/${testId}/recorder/start`, {
      method: "POST",
      body: JSON.stringify(baseUrl ? { baseUrl } : {}),
    }),
  recorderPause: (sessionId: string) =>
    day6req<void>(`/recorder/${sessionId}/pause`, { method: "POST" }),
  recorderResume: (sessionId: string) =>
    day6req<void>(`/recorder/${sessionId}/resume`, { method: "POST" }),
  recorderStop: (sessionId: string) =>
    day6req<unknown>(`/recorder/${sessionId}/stop`, { method: "POST" }),
};

/* ---------- Day 6 domain types ---------- */

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  baseUrl?: string | null;
}
export interface Environment {
  id: string;
  projectId: string;
  name: string;
  isDefault: boolean;
  baseUrl?: string | null;
}
/** Secret values are NEVER returned as plaintext (server masks them as null). */
export interface Variable {
  id: string;
  projectId: string;
  environmentId: string | null;
  key: string;
  isSecret: boolean;
  /** Plain value for non-secrets; null for secrets (masked). */
  value: string | null;
  hasValue?: boolean;
}
export interface RunStep {
  id: string;
  runId: string;
  stepId: string;
  sortOrder: number;
  status: string;
  errorMessage?: string | null;
  durationMs?: number | null;
}
export interface Run {
  id: string;
  projectId: string;
  testId: string;
  environmentId?: string | null;
  browser: string;
  status: string;
  errorSummary?: string | null;
  steps?: RunStep[];
}

export const apiBase = API_BASE;
