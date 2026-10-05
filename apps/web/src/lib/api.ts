/**
 * Builder API client (Day 5-6).
 *
 * Test-locator contract:
 *   POST /api/v1/tests/:id/locator/test      { candidate } -> { matches, preview, healthy }
 *   POST /api/v1/recorder/:sessionId/locator/test  (same shape, exists in P0 server)
 * Client prefers the tests/:id variant and falls back to the recorder-session
 * variant when the former 404s (P0 server only implements the latter).
 *
 * Honesty contract (05-locator): with no live browser attached to the
 * recorder session the server answers
 *   503 { code: "RECORDER_NO_LIVE_BROWSER", preview: null }
 * and NEVER fabricates a match count. Non-OK responses throw an Error whose
 * message embeds the machine code (`HTTP <status> <CODE>: <message>`) so the
 * UI can render a dedicated no-live-browser state.
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

/** Extract `{ code, message }` from a JSON error body; fall back to raw text. */
function locatorHttpError(status: number, text: string): Error {
  try {
    const body = JSON.parse(text) as { code?: unknown; message?: unknown };
    const code = typeof body.code === "string" ? body.code : undefined;
    const message =
      typeof body.message === "string" ? body.message : text.slice(0, 300);
    return new Error(code ? `HTTP ${status} ${code}: ${message}` : `HTTP ${status}: ${message}`);
  } catch {
    return new Error(`HTTP ${status}: ${text.slice(0, 300)}`);
  }
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
        throw locatorHttpError(res.status, await res.text());
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
  if (!res.ok) throw locatorHttpError(res.status, await res.text());
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
    "/api/v1").replace(/\/$/, "");

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
      // NOTE: no literal "content-type" here — day6Headers() (via
      // authHeaders()) already sets "Content-Type". A duplicate key with
      // different casing makes fetch send "a, b", which Fastify rejects
      // (FST_ERR_CTP_INVALID_MEDIA_TYPE → "Unsupported Media Type").
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
  baseUrl?: string | null;
}
export interface TestRecord {
  id: string;
  projectId?: string;
  name: string;
}

export interface SuiteRecord {
  id: string;
  projectId: string;
  name: string;
  description?: string | null;
  tests?: SuiteMember[];
}
export interface SuiteMember {
  suiteId: string;
  testId: string;
  sortOrder: number;
  test?: { id: string; name: string };
}
export interface SuiteExecution {
  suiteRunId: string;
  suiteId: string;
  status: string;
  counts: { total: number; passed: number; failed: number; running: number; cancelled: number };
  lastActivityAt: number;
}
export interface SuiteRunDetail {
  suiteRunId: string;
  suite: SuiteRecord | null;
  status: string;
  tests: Array<{
    testId: string;
    testName: string;
    retryCount: number;
    finalStatus: string;
    attempts: Array<{
      runId: string;
      attempt: number;
      status: string;
      browser: string;
      trigger: string;
      errorSummary?: string | null;
      durationMs?: number | null;
    }>;
  }>;
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
  createProject: (payload: { name: string; description?: string; baseUrl?: string }) =>
    day6req<ProjectRecord>(`/projects`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  listTests: (projectId: string, tag?: string) =>
    day6req<TestRecord[]>(`/projects/${projectId}/tests${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`),
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
  createRun: (testId: string, opts: { environmentId: string; browser?: string; headed?: boolean; datasetId?: string; rowIndex?: number; profileId?: string; healWithAlternatives?: boolean; slowMoMs?: number; debug?: boolean; viewport?: { width: number; height: number }; artifacts?: { trace?: 'on' | 'off' | 'retain-on-failure'; screenshot?: 'on' | 'off' | 'only-on-failure'; video?: 'on' | 'off' | 'retain-on-failure' } }) =>
    day6req<{ id: string; status: string }>(`/tests/${testId}/runs`, {
      method: "POST",
      body: JSON.stringify({ environmentId: opts.environmentId, browser: opts.browser ?? "chromium", headed: opts.headed ?? false, ...(opts.datasetId ? { datasetId: opts.datasetId } : {}), ...(opts.rowIndex !== undefined ? { rowIndex: opts.rowIndex } : {}), ...(opts.profileId ? { profileId: opts.profileId } : {}), ...(opts.healWithAlternatives === true ? { healWithAlternatives: true } : {}), ...(opts.slowMoMs !== undefined ? { slowMoMs: opts.slowMoMs } : {}), ...(opts.debug === true ? { debug: true } : {}), ...(opts.viewport ? { viewport: opts.viewport } : {}), ...(opts.artifacts ? { artifacts: opts.artifacts } : {}) }),
    }),
  /* P1 datasets (definition-embedded): import CSV/JSON text, delete a table. */
  importDataset: (testId: string, payload: { format: "csv" | "json"; name?: string; content: string }) =>
    day6req<{ dataset: DataSet; definitionJson: unknown }>(`/tests/${testId}/datasets/import`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  deleteDataset: (testId: string, datasetId: string) =>
    day6req<{ deleted: string; definitionJson: unknown }>(`/tests/${testId}/datasets/${datasetId}`, {
      method: "DELETE",
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
    day6req<void>(`/recorder/${sessionId}/pause`, { method: "POST", body: "{}" }),
  recorderResume: (sessionId: string) =>
    day6req<void>(`/recorder/${sessionId}/resume`, { method: "POST", body: "{}" }),
  recorderStop: (sessionId: string) =>
    day6req<unknown>(`/recorder/${sessionId}/stop`, { method: "POST", body: "{}" }),

  /* P1 — Reusable actions/business keywords + parameters. */
  listActions: (projectId: string) =>
    day6req<ActionRecord[]>(`/projects/${projectId}/actions`),
  createAction: (projectId: string, payload: ActionCreate) =>
    day6req<ActionRecord>(`/projects/${projectId}/actions`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getAction: (actionId: string) =>
    day6req<ActionRecord>(`/actions/${actionId}`),
  updateAction: (actionId: string, payload: ActionUpdate) =>
    day6req<ActionRecord>(`/actions/${actionId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteAction: (actionId: string) =>
    day6req<void>(`/actions/${actionId}`, { method: "DELETE" }),

  /* P1 — Suites/tags + suite runs + JUnit export. */
  listSuites: (projectId: string) =>
    day6req<SuiteRecord[]>(`/projects/${projectId}/suites`),
  createSuite: (projectId: string, name: string, description?: string) =>
    day6req<SuiteRecord>(`/projects/${projectId}/suites`, {
      method: "POST",
      body: JSON.stringify({ name, ...(description ? { description } : {}) }),
    }),
  getSuite: (suiteId: string) => day6req<SuiteRecord>(`/suites/${suiteId}`),
  deleteSuite: (suiteId: string) =>
    day6req<void>(`/suites/${suiteId}`, { method: "DELETE" }),
  listSuiteMembers: (suiteId: string) =>
    day6req<SuiteMember[]>(`/suites/${suiteId}/tests`),
  addSuiteMember: (suiteId: string, testId: string) =>
    day6req<SuiteMember>(`/suites/${suiteId}/tests`, {
      method: "POST",
      body: JSON.stringify({ testId }),
    }),
  reorderSuiteMembers: (suiteId: string, testIds: string[]) =>
    day6req<SuiteMember[]>(`/suites/${suiteId}/tests`, {
      method: "PUT",
      body: JSON.stringify({ testIds }),
    }),
  removeSuiteMember: (suiteId: string, testId: string) =>
    day6req<void>(`/suites/${suiteId}/tests/${testId}`, { method: "DELETE" }),
  listTags: (projectId: string) =>
    day6req<Array<{ tag: string; count: number }>>(`/projects/${projectId}/tags`),
  runSuite: (
    suiteId: string,
    opts: { environmentId: string; browser?: string; headed?: boolean; retries?: number; parallel?: number; profileId?: string; healWithAlternatives?: boolean },
  ) =>
    day6req<{ suiteRunId: string; runs?: Array<{ id: string; testId: string }> }>(
      `/suites/${suiteId}/runs`,
      {
        method: "POST",
        body: JSON.stringify({
          environmentId: opts.environmentId,
          browser: opts.browser ?? "chromium",
          headed: opts.headed ?? false,
          retries: opts.retries ?? 0,
          parallel: opts.parallel ?? 2,
          ...(opts.profileId ? { profileId: opts.profileId } : {}),
          ...(opts.healWithAlternatives === true ? { healWithAlternatives: true } : {}),
        }),
      },
    ),
  listSuiteRuns: (suiteId: string) =>
    day6req<SuiteExecution[]>(`/suites/${suiteId}/runs`),
  /** Tests in this suite tagged as write behavior (warn, never block). */
  listSuiteSideEffects: (suiteId: string) =>
    day6req<{ suiteId: string; tests: Array<{ testId: string; name: string; tags: string[] }> }>(
      `/suites/${suiteId}/side-effects`,
    ),
  getSuiteRun: (suiteRunId: string) =>
    day6req<SuiteRunDetail>(`/suite-runs/${suiteRunId}`),
  cancelSuiteRun: (suiteRunId: string) =>
    day6req<{ suiteRunId: string; cancelled: string[]; alreadyTerminal: string[] }>(
      `/suite-runs/${suiteRunId}/cancel`,
      // NOTE: Fastify rejects `content-type: application/json` with an empty
      // body (400) — bodiless POSTs must send '{}' explicitly.
      { method: "POST", body: "{}" },
    ),
  /* P1 wave 2 — Auth profiles (storageState; secret/state never returned). */
  listProfiles: (projectId: string) =>
    day6req<AuthProfile[]>(`/projects/${projectId}/profiles`),
  createProfile: (projectId: string, payload: { name: string; environmentId?: string; storageStateJson?: string }) =>
    day6req<AuthProfile>(`/projects/${projectId}/profiles`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getProfile: (profileId: string) =>
    day6req<AuthProfile>(`/profiles/${profileId}`),
  updateProfile: (profileId: string, payload: { name?: string; environmentId?: string | null; storageStateJson?: string }) =>
    day6req<AuthProfile>(`/profiles/${profileId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteProfile: (profileId: string) =>
    day6req<void>(`/profiles/${profileId}`, { method: "DELETE" }),

  /* P1 wave 2 — File library (base64 upload; download via blob). */
  listFiles: (projectId: string) =>
    day6req<FileAsset[]>(`/projects/${projectId}/files`),
  uploadFile: (projectId: string, payload: { name: string; contentBase64: string; mimeType?: string }) =>
    day6req<FileAsset>(`/projects/${projectId}/files`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  deleteFile: (fileId: string) =>
    day6req<void>(`/files/${fileId}`, { method: "DELETE" }),
  downloadFile: async (fileId: string, fallbackName: string): Promise<void> => {
    const res = await fetch(`${API_BASE}/files/${fileId}/download`, { headers: day6Headers() });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let code = "REQUEST_FAILED";
      let message = `Download failed: HTTP ${res.status}`;
      try {
        const body = JSON.parse(text) as { code?: string; message?: string };
        if (body.code) code = body.code;
        if (body.message) message = body.message;
      } catch { /* keep defaults */ }
      throw new ApiError(code, message, res.status);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = fallbackName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  },

  /* P1 wave 2 — Schedules (cron; runs with trigger='schedule'). */
  listSchedules: (projectId: string) =>
    day6req<ScheduleRecord[]>(`/projects/${projectId}/schedules`),
  createSchedule: (projectId: string, payload: ScheduleCreate) =>
    day6req<ScheduleRecord>(`/projects/${projectId}/schedules`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateSchedule: (scheduleId: string, payload: ScheduleUpdate) =>
    day6req<ScheduleRecord>(`/schedules/${scheduleId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteSchedule: (scheduleId: string) =>
    day6req<void>(`/schedules/${scheduleId}`, { method: "DELETE" }),
  listScheduleRuns: (scheduleId: string) =>
    day6req<ScheduleRun[]>(`/schedules/${scheduleId}/runs`),
  runScheduleNow: (scheduleId: string) =>
    day6req<{ runId?: string; suiteRunId?: string }>(`/schedules/${scheduleId}/runs`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  /* P1 wave 2 — Project export/import + spec import. */
  exportProjectUrl: (projectId: string) =>
    `${API_BASE}/projects/${projectId}/export?format=json`,
  downloadProjectExport: async (projectId: string): Promise<void> => {
    const res = await fetch(`${API_BASE}/projects/${projectId}/export?format=json`, { headers: day6Headers() });
    if (!res.ok) throw new ApiError("REQUEST_FAILED", `Export failed: HTTP ${res.status}`, res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = `${projectId}.export.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  },
  importProject: (payload: { data: unknown }) =>
    day6req<{ id: string; name?: string }>(`/projects/import`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  importSpec: (projectId: string, code: string) =>
    day6req<{ definition: unknown; warnings: string[] }>(`/projects/${projectId}/import-spec`, {
      method: "POST",
      body: JSON.stringify({ code }),
    }),

  /** Download JUnit XML (suite run or single run) via blob anchor. */
  downloadJUnit: async (kind: "suite-run" | "run", id: string): Promise<void> => {
    const path =
      kind === "suite-run" ? `/suite-runs/${id}/export?format=junit` : `/runs/${id}/export?format=junit`;
    const res = await fetch(`${API_BASE}${path}`, { headers: day6Headers() });
    if (!res.ok) throw new ApiError("REQUEST_FAILED", `JUnit export failed: HTTP ${res.status}`, res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = `${id}.junit.xml`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  },
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
/** P1 — reusable action parameter (secret params resolve at run time). */
export interface ActionParameter {
  name: string;
  description?: string;
  default?: string;
  secret?: boolean;
}
/** P1 — reusable business action (project-scoped; body is P0 steps only). */
export interface ActionRecord {
  schemaVersion: "1.0";
  id: string;
  projectId: string;
  name: string;
  description?: string;
  parameters: ActionParameter[];
  steps: Array<Record<string, unknown> & { id: string; type: string; enabled: boolean }>;
}
export interface ActionCreate {
  name: string;
  description?: string;
  parameters?: ActionParameter[];
  steps: Array<Record<string, unknown>>;
}
export interface ActionUpdate {
  name?: string;
  description?: string | null;
  parameters?: ActionParameter[];
  steps?: Array<Record<string, unknown>>;
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
  /** P2 healing evidence surfaced live (proposal itself via GET healing). */
  healEvidence?: unknown;
}
/** P1 — embedded dataset table (rows are plaintext; secrets stay in variables). */
export interface DataSet {
  id: string;
  name: string;
  rows: Record<string, string>[];
}
/** P1 wave 2 — auth profile (storageState never returned; only presence flag). */
export interface AuthProfile {
  id: string;
  projectId: string;
  name: string;
  environmentId?: string | null;
  environmentName?: string | null;
  /** True when a storageState was saved (value itself is never exposed). */
  hasStorageState: boolean;
  createdAt?: string;
}
/** P1 wave 2 — file library entry (content only via /download). */
export interface FileAsset {
  id: string;
  projectId: string;
  name: string;
  mimeType?: string | null;
  sizeBytes: number;
  createdAt?: string;
  /** Steps currently referencing this file (optional; server may omit). */
  usedBy?: Array<{ testId: string; testName?: string; stepId: string; stepName?: string }>;
}
/** P1 wave 2 — scheduled run (suite or single test). */
export interface ScheduleRecord {
  id: string;
  projectId: string;
  name?: string | null;
  suiteId?: string | null;
  suiteName?: string | null;
  testId?: string | null;
  testName?: string | null;
  environmentId: string;
  environmentName?: string | null;
  cron: string;
  enabled: boolean;
  retries?: number | null;
  lastStatus?: string | null;
  nextRunAt?: string | null;
}
export interface ScheduleCreate {
  name?: string;
  suiteId?: string;
  testId?: string;
  environmentId: string;
  cron: string;
  enabled?: boolean;
  retries?: number;
}
export interface ScheduleUpdate {
  name?: string | null;
  suiteId?: string | null;
  testId?: string | null;
  environmentId?: string;
  cron?: string;
  enabled?: boolean;
  retries?: number | null;
}
export interface ScheduleRun {
  id: string;
  status: string;
  trigger?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  testName?: string | null;
  errorSummary?: string | null;
}
/** True when the backend route does not exist yet (parallel P1 agents). */
export function isNotImplemented(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 404 || e.code === "NOT_FOUND" || e.code === "ROUTE_NOT_FOUND");
}
/**
 * 404 detector for clients that throw plain Errors (p2api, raw fetch):
 * matches `ApiError` 404s plus messages like "API 404: …" / "HTTP 404: …".
 */
export function isNotFoundError(e: unknown): boolean {
  if (isNotImplemented(e)) return true;
  if (e instanceof ApiError) return false;
  const msg = e instanceof Error ? `${e.message}` : typeof e === "string" ? e : "";
  return /(^|[^0-9])404([^0-9]|$)|NOT_FOUND|ROUTE_NOT_FOUND/.test(msg);
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
