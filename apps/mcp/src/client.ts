/**
 * client.ts — minimal Studio REST client for the MCP tools.
 *
 * Talks to the EXISTING REST surface only (routes are reused, never forked).
 * The Bearer token lives in this client and is only ever placed in the
 * `Authorization` header — tool results carry redacted summaries, never
 * secrets (the server already masks secret values on read).
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
  constructor(status: number, message: string) {
    super(message);
    this.name = 'StudioApiError';
    this.status = status;
  }
}

export interface ProjectSummary {
  id: string;
  name: string;
  description?: string | null;
}

export interface TestSummary {
  id: string;
  name: string;
  projectId: string;
  stepCount: number;
  steps: Array<{ id: string; type: string; name?: string }>;
  definitionJson?: unknown;
}

export interface RunSummary {
  id: string;
  status: string;
  steps: Array<{ stepId: string; status: string; error?: string }>;
  error?: string | null;
}

export interface HealingSummary {
  id: string;
  stepId: string;
  from: string;
  to: string;
  verified: boolean;
  status: string;
}

function defaultFetch(): FetchFn {
  const g = globalThis.fetch;
  if (!g) throw new Error('Global fetch is unavailable (Node 18+ required)');
  return (url, init) =>
    g(url, { method: init?.method ?? 'GET', headers: init?.headers, body: init?.body }) as Promise<MinimalResponse>;
}

function errText(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
    const code = typeof parsed.code === 'string' ? parsed.code : undefined;
    const message = typeof parsed.message === 'string' ? parsed.message : undefined;
    if (code || message) return `HTTP ${status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`;
  } catch {
    // Non-JSON — fall through to a truncated snippet.
  }
  const snippet = text.slice(0, 300).replace(/\s+/g, ' ').trim();
  return snippet ? `HTTP ${status}: ${snippet}` : `HTTP ${status}`;
}

export class StudioClient {
  private readonly api: string;
  private readonly token: string;
  private readonly fetchFn: FetchFn;

  constructor(apiBase: string, token: string, fetchFn?: FetchFn) {
    this.api = apiBase.replace(/\/+$/, '');
    this.token = token;
    this.fetchFn = fetchFn ?? defaultFetch();
  }

  private headers(json: boolean): Record<string, string> {
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
    if (!res.ok) throw new StudioApiError(res.status, errText(res.status, text));
    return text;
  }

  private async requestJson<T>(path: string, method: string, body?: unknown): Promise<T> {
    return JSON.parse(await this.request(path, method, body)) as T;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return this.requestJson('/api/v1/projects', 'GET');
  }

  async listTests(projectId: string, tag?: string): Promise<Array<{ id: string; name: string }>> {
    const q = tag ? `?tag=${encodeURIComponent(tag)}` : '';
    return this.requestJson(`/api/v1/projects/${encodeURIComponent(projectId)}/tests${q}`, 'GET');
  }

  async getTest(testId: string): Promise<TestSummary> {
    const row = await this.requestJson<{ id: string; projectId: string; name: string; definitionJson: unknown }>(
      `/api/v1/tests/${encodeURIComponent(testId)}`,
      'GET',
    );
    const def = typeof row.definitionJson === 'string' ? safeJson(row.definitionJson) : row.definitionJson;
    const steps = Array.isArray((def as { steps?: unknown })?.steps)
      ? ((def as { steps: Array<{ id: string; type: string; name?: string }> }).steps ?? [])
      : [];
    return {
      id: row.id,
      name: row.name,
      projectId: row.projectId,
      stepCount: steps.length,
      steps: steps.map((s) => ({ id: String(s.id), type: String(s.type), ...(s.name !== undefined ? { name: String(s.name) } : {}) })),
      definitionJson: def,
    };
  }

  async exportSpec(testId: string): Promise<string> {
    return this.request(`/api/v1/tests/${encodeURIComponent(testId)}/export?format=spec`, 'GET');
  }

  async createRun(testId: string, body: { environmentId: string; browser?: string; headed?: boolean }): Promise<{ id: string; status: string }> {
    return this.requestJson(`/api/v1/tests/${encodeURIComponent(testId)}/runs`, 'POST', {
      environmentId: body.environmentId,
      browser: body.browser ?? 'chromium',
      headed: body.headed ?? false,
    });
  }

  async getRun(runId: string): Promise<RunSummary> {
    const run = await this.requestJson<{
      id: string; status: string; error?: string | null; steps?: Array<{ stepId: string; status: string; errorMessage?: string | null }>;
    }>(`/api/v1/runs/${encodeURIComponent(runId)}`, 'GET');
    return {
      id: run.id,
      status: run.status,
      steps: (run.steps ?? []).map((s) => ({
        stepId: s.stepId,
        status: s.status,
        ...(s.errorMessage ? { error: truncate(s.errorMessage, 2000) } : {}),
      })),
      ...(run.error !== undefined ? { error: run.error } : {}),
    };
  }

  async listHealing(testId: string): Promise<HealingSummary[]> {
    const rows = await this.requestJson<Array<{
      id: string; stepId: string; fromLocator: string; toLocator: string; evidence: string; status: string;
    }>>(`/api/v1/tests/${encodeURIComponent(testId)}/healing`, 'GET');
    return (rows ?? []).map((r) => ({
      id: r.id,
      stepId: r.stepId,
      from: r.fromLocator,
      to: r.toLocator,
      verified: safeJson(r.evidence)?.verified === true,
      status: r.status,
    }));
  }

  async parseGherkin(text: string): Promise<{ steps: unknown[]; unparsed: string[]; warnings: string[] }> {
    return this.requestJson('/api/v1/ai/gherkin', 'POST', { text });
  }

  async explainRun(runId: string): Promise<{ engine: string; explanation: unknown }> {
    return this.requestJson('/api/v1/ai/explain', 'POST', { runId });
  }
}

function safeJson(text: string): Record<string, boolean> {
  try {
    return JSON.parse(text) as Record<string, boolean>;
  } catch {
    return {};
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…(truncated)` : s;
}
