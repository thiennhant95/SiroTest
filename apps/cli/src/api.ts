/**
 * Minimal HTTP client for the Studio server API.
 *
 * Talks to the EXISTING REST surface only (routes are reused, never forked):
 * - POST /api/v1/tests/:id/runs + GET /api/v1/runs/:id
 * - POST /api/v1/suites/:sid/runs + GET /api/v1/suite-runs/:id
 * - GET /api/v1/tests/:id/export?format=spec
 * - GET /api/v1/runs/:id/export?format=junit
 * - GET /api/v1/suite-runs/:id/export?format=junit
 *
 * Auth is the same contract as every other REST caller: `Authorization:
 * Bearer <token>`. The token is only ever placed in the header — never in
 * URLs, bodies, errors or logs.
 */
export type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<MinimalResponse>;

export interface MinimalResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export class StudioApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'StudioApiError';
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

export interface RunJson {
  id: string;
  status: string;
  durationMs?: number | null;
  errorSummary?: string | null;
  steps?: Array<{ status?: string }>;
  artifacts?: Array<{ type?: string; path?: string }>;
  [key: string]: unknown;
}

export interface SuiteRunJson {
  suiteRunId: string;
  status: string;
  tests?: Array<{
    testId?: string;
    testName?: string;
    finalStatus?: string;
    attempts?: Array<{ status?: string }>;
  }>;
  runs?: Array<{ id: string; testId?: string; status?: string }>;
  [key: string]: unknown;
}

function defaultFetch(): FetchFn {
  const g = globalThis.fetch;
  if (!g) throw new Error('Global fetch is unavailable (Node 18+ required)');
  return (url, init) =>
    g(url, {
      method: init?.method ?? 'GET',
      headers: init?.headers,
      body: init?.body,
    }) as Promise<MinimalResponse>;
}

export class StudioClient {
  private readonly api: string;
  private readonly token: string;
  private readonly fetchFn: FetchFn;

  constructor(api: string, token: string, fetchFn?: FetchFn) {
    this.api = api.replace(/\/+$/, '');
    this.token = token;
    this.fetchFn = fetchFn ?? defaultFetch();
  }

  private headers(json: boolean): Record<string, string> {
    // Bearer contract shared with the server auth (auth.ts); the header map
    // itself is never logged by this CLI.
    const h: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  private async request(path: string, method: string, body?: unknown): Promise<string> {
    let res: MinimalResponse;
    try {
      res = await this.fetchFn(`${this.api}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new StudioApiError(0, `Request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new StudioApiError(res.status, studioErrorMessage(res.status, text));
    }
    return text;
  }

  private async requestJson<T>(path: string, method: string, body?: unknown): Promise<T> {
    return JSON.parse(await this.request(path, method, body)) as T;
  }

  createTestRun(
    testId: string,
    body: { environmentId: string; browser: string; headed: boolean; datasetId?: string; rowIndex?: number },
  ): Promise<RunJson> {
    return this.requestJson(`/api/v1/tests/${encodeURIComponent(testId)}/runs`, 'POST', body);
  }

  getRun(runId: string): Promise<RunJson> {
    return this.requestJson(`/api/v1/runs/${encodeURIComponent(runId)}`, 'GET');
  }

  createSuiteRun(
    suiteId: string,
    body: { environmentId: string; browser: string; headed: boolean; retries: number; parallel: number },
  ): Promise<{ suiteRunId: string } & Record<string, unknown>> {
    return this.requestJson(`/api/v1/suites/${encodeURIComponent(suiteId)}/runs`, 'POST', body);
  }

  getSuiteRun(suiteRunId: string): Promise<SuiteRunJson> {
    return this.requestJson(`/api/v1/suite-runs/${encodeURIComponent(suiteRunId)}`, 'GET');
  }

  exportSpec(testId: string, datasetId?: string): Promise<string> {
    const q = datasetId ? `?format=spec&datasetId=${encodeURIComponent(datasetId)}` : '?format=spec';
    return this.request(`/api/v1/tests/${encodeURIComponent(testId)}/export${q}`, 'GET');
  }

  exportRunJUnit(runId: string): Promise<string> {
    return this.request(`/api/v1/runs/${encodeURIComponent(runId)}/export?format=junit`, 'GET');
  }

  exportSuiteRunJUnit(suiteRunId: string): Promise<string> {
    return this.request(`/api/v1/suite-runs/${encodeURIComponent(suiteRunId)}/export?format=junit`, 'GET');
  }
}

/** Prefer the server's machine-readable {code,message}; never echo secrets. */
function studioErrorMessage(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
    const code = typeof parsed.code === 'string' ? parsed.code : undefined;
    const message = typeof parsed.message === 'string' ? parsed.message : undefined;
    if (code || message) return `HTTP ${status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`;
  } catch {
    // Non-JSON error page — fall through to a truncated raw body.
  }
  const snippet = text.slice(0, 300).replace(/\s+/g, ' ').trim();
  return snippet ? `HTTP ${status}: ${snippet}` : `HTTP ${status}`;
}
