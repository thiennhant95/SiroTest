import { decryptSecret, encryptSecret } from './security.js';
import { ApiError } from './errors.js';
import { db } from './db.js';

/**
 * Outbound integrations: bug-from-failure (Jira / Backlog / Slack / Lark)
 * plus generic HMAC webhooks (`webhook`) for run-terminal events.
 * Secrets (tokens/keys) are AES-256-GCM encrypted in Integration.secretJson
 * and never returned to clients; config (space, project key, webhook URL…)
 * is plaintext. Outbound targets pass the SSRF URL guard.
 */

export type Provider = 'jira' | 'backlog' | 'slack' | 'lark' | 'webhook';

export const PROVIDERS: Record<Provider, { configFields: string[]; secretFields: string[] }> = {
  jira: { configFields: ['site', 'projectKey', 'issueType'], secretFields: ['email', 'apiToken'] },
  backlog: { configFields: ['space', 'projectId', 'issueTypeId'], secretFields: ['apiKey'] },
  slack: { configFields: ['webhookUrl'], secretFields: [] },
  lark: { configFields: ['webhookUrl'], secretFields: [] },
  webhook: { configFields: ['url'], secretFields: ['signingSecret'] },
};

export function parseProvider(raw: unknown): Provider {
  if (raw === 'jira' || raw === 'backlog' || raw === 'slack' || raw === 'lark' || raw === 'webhook') return raw;
  throw new ApiError('VALIDATION_ERROR', `provider must be one of ${Object.keys(PROVIDERS).join('|')}`, 400);
}

export function encryptSecrets(secrets: Record<string, string>): string {
  return encryptSecret(JSON.stringify(secrets ?? {}));
}

export function decryptSecrets(stored: string): Record<string, string> {
  try {
    const raw = decryptSecret(stored || '');
    const parsed: unknown = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

export interface BugPayload {
  title: string;
  markdown: string;
  runUrl?: string;
  /** Event name for generic webhooks (e.g. 'run.passed' | 'run.failed'). */
  event?: string;
  /** PNG bytes to attach (Backlog only for now; capped by caller). */
  attachments?: Array<{ filename: string; bytes: Buffer; mimeType: string }>;
}

export interface Delivery {
  ok: boolean;
  externalId?: string;
  externalUrl?: string;
  provider: Provider;
}

/**
 * Generic run-terminal fan-out to enabled `webhook` integrations.
 * Fire-and-forget by design: callers use `void notifyRunWebhooks(…)` —
 * delivery failures never fail or delay the run. Only terminal outcomes
 * (passed/failed/cancelled) are sent; retries emit per-attempt only when
 * the caller passes each attempt explicitly.
 */
export async function notifyRunWebhooks(opts: {
  projectId: string;
  event: 'run.passed' | 'run.failed' | 'run.cancelled';
  runId: string;
  status: string;
  trigger?: string;
  testName?: string;
  suiteRunId?: string;
  errorSummary?: string | null;
}): Promise<void> {
  try {
    const rows = await db().integration.findMany({
      where: { projectId: opts.projectId, enabled: true, provider: 'webhook' },
    });
    if (rows.length === 0) return;
    const subject = opts.testName ? `test "${opts.testName}"` : `run ${opts.runId}`;
    const title = `[Studio] ${opts.event}: ${subject} (${opts.status})`;
    const lines = [
      `run: ${opts.runId}`,
      `trigger: ${opts.trigger ?? 'manual'}`,
      ...(opts.suiteRunId ? [`suite run: ${opts.suiteRunId}`] : []),
      (opts.errorSummary ?? '').slice(0, 1500),
    ].filter((l) => l.length > 0);
    const payload = { event: opts.event, title, markdown: lines.join('\n') };
    for (const row of rows) {
      try {
        const config = JSON.parse(row.configJson || '{}') as Record<string, string>;
        await sendToProvider('webhook', config, decryptSecrets(row.secretJson), payload);
      } catch {
        // per-target best-effort — one bad webhook never blocks the rest
      }
    }
  } catch {
    // lookup failure must never break run settlement
  }
}

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Jira Cloud description (ADF) from plain markdown-ish text. */
function adfDoc(text: string): unknown {
  const content: unknown[] = [];
  let fence: string[] | null = null;
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('```')) {
      if (fence) {
        content.push({ type: 'codeBlock', attrs: { language: 'text' }, content: [{ type: 'text', text: fence.join('\n') }] });
        fence = null;
      } else {
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    if (line.trim() === '') continue;
    if (line.startsWith('## ')) {
      content.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: line.slice(3).trim() }] });
      continue;
    }
    content.push({ type: 'paragraph', content: [{ type: 'text', text: line.replace(/^\*\*([^*]+)\*\*/, '$1').replace(/^[-*]\s+/, '• ') }] });
  }
  if (fence) {
    content.push({ type: 'codeBlock', attrs: { language: 'text' }, content: [{ type: 'text', text: fence.join('\n') }] });
  }
  return { type: 'doc', version: 1, content: content.length > 0 ? content : [{ type: 'paragraph', content: [{ type: 'text', text: '(empty)' }] }] };
}

async function postJson(url: string, init: { headers?: Record<string, string>; body: unknown }, timeoutMs = 20000): Promise<{ status: number; json: unknown; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      body: JSON.stringify(init.body),
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

async function postForm(url: string, params: Record<string, string>, timeoutMs = 20000): Promise<{ status: number; json: unknown; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendToProvider(
  provider: Provider,
  config: Record<string, string>,
  secrets: Record<string, string>,
  payload: BugPayload,
): Promise<Delivery> {
  switch (provider) {
    case 'jira': {
      const site = (config.site ?? '').replace(/\/$/, '');
      const email = secrets.email ?? '';
      const apiToken = secrets.apiToken ?? '';
      if (!site || !config.projectKey || !email || !apiToken) {
        throw new ApiError('VALIDATION_ERROR', 'jira needs config.site/projectKey/issueType + secrets.email/apiToken', 400);
      }
      const auth = Buffer.from(`${email}:${apiToken}`, 'utf8').toString('base64');
      const r = await postJson(
        `${site}/rest/api/3/issue`,
        {
          headers: { Authorization: `Basic ${auth}` },
          body: {
            fields: {
              project: { key: config.projectKey },
              summary: trunc(payload.title, 255),
              description: adfDoc(payload.markdown),
              issuetype: { name: config.issueType ?? 'Bug' },
            },
          },
        },
      );
      if (r.status < 200 || r.status >= 300) {
        throw new ApiError('VALIDATION_ERROR', `jira rejected the issue (HTTP ${r.status}): ${r.text.slice(0, 300)}`, 400);
      }
      const key = (r.json as { key?: string } | null)?.key ?? '';
      return { ok: true, provider, externalId: key || undefined, externalUrl: key ? `${site}/browse/${key}` : undefined };
    }
    case 'backlog': {
      const space = (config.space ?? '').replace(/\/$/, '');
      const apiKey = secrets.apiKey ?? '';
      if (!space || !config.projectId || !config.issueTypeId || !apiKey) {
        throw new ApiError('VALIDATION_ERROR', 'backlog needs config.space/projectId/issueTypeId + secrets.apiKey', 400);
      }
      // Upload screenshots first (Backlog wants attachmentIds at create time).
      const attachmentIds: number[] = [];
      for (const a of payload.attachments ?? []) {
        const form = new FormData();
        form.append('file', new Blob([a.bytes as unknown as BlobPart], { type: a.mimeType }), a.filename);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        try {
          const up = await fetch(`${space}/api/v2/space/attachment?apiKey=${encodeURIComponent(apiKey)}`, {
            method: 'POST',
            body: form,
            signal: ctrl.signal,
          });
          if (!up.ok) break;
          const uj = (await up.json().catch(() => null)) as { id?: number } | null;
          if (uj && typeof uj.id === 'number') attachmentIds.push(uj.id);
          if (attachmentIds.length >= 5) break;
        } catch {
          break;
        } finally {
          clearTimeout(timer);
        }
      }
      const formParams: Record<string, string> = {
        projectId: config.projectId,
        summary: trunc(payload.title, 255),
        description: payload.markdown,
        issueTypeId: config.issueTypeId,
        ...(config.priorityId ? { priorityId: config.priorityId } : {}),
      };
      const bodyStr = new URLSearchParams(formParams).toString()
        + attachmentIds.map((id) => `&attachmentId[]=${id}`).join('');
      const ctrl2 = new AbortController();
      const timer2 = setTimeout(() => ctrl2.abort(), 20000);
      let r: { status: number; json: unknown; text: string };
      try {
        const resp = await fetch(`${space}/api/v2/issues?apiKey=${encodeURIComponent(apiKey)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: bodyStr,
          signal: ctrl2.signal,
        });
        const text = await resp.text().catch(() => '');
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        r = { status: resp.status, json, text };
      } finally {
        clearTimeout(timer2);
      }
      if (r.status < 200 || r.status >= 300) {
        throw new ApiError('VALIDATION_ERROR', `backlog rejected the issue (HTTP ${r.status}): ${r.text.slice(0, 300)}`, 400);
      }
      const j = r.json as { issueKey?: string; id?: number } | null;
      return {
        ok: true,
        provider,
        externalId: j?.issueKey ?? (j?.id !== undefined ? String(j.id) : undefined),
        externalUrl: j?.issueKey ? `${space}/view/${j.issueKey}` : undefined,
      };
    }
    case 'slack': {
      const webhookUrl = config.webhookUrl ?? '';
      if (!webhookUrl) throw new ApiError('VALIDATION_ERROR', 'slack needs config.webhookUrl (incoming webhook)', 400);
      const r = await postJson(webhookUrl, {
        body: { text: `*${payload.title}*${payload.runUrl ? ` <${payload.runUrl}|open run>` : ''}\n${trunc(payload.markdown, 3000)}` },
      });
      if (r.status < 200 || r.status >= 300) {
        throw new ApiError('VALIDATION_ERROR', `slack rejected the message (HTTP ${r.status}): ${r.text.slice(0, 300)}`, 400);
      }
      return { ok: true, provider };
    }
    case 'lark': {
      const webhookUrl = config.webhookUrl ?? '';
      if (!webhookUrl) throw new ApiError('VALIDATION_ERROR', 'lark needs config.webhookUrl (custom bot)', 400);
      const r = await postJson(webhookUrl, {
        body: {
          msg_type: 'interactive',
          card: {
            header: { title: { tag: 'plain_text', content: trunc(payload.title, 200) } },
            elements: [{ tag: 'markdown', content: trunc(payload.markdown, 2500) }],
          },
        },
      });
      const code = (r.json as { StatusCode?: number; code?: number } | null)?.StatusCode ?? (r.json as { code?: number } | null)?.code;
      if (r.status < 200 || r.status >= 300 || (code !== undefined && code !== 0)) {
        throw new ApiError('VALIDATION_ERROR', `lark rejected the message (HTTP ${r.status}): ${r.text.slice(0, 300)}`, 400);
      }
      return { ok: true, provider };
    }
    case 'webhook': {
      // Generic HMAC webhook for run-terminal events (CI dashboards, chat
      // relays). Body is JSON; signed with the optional signingSecret so the
      // receiver can verify authenticity (X-VV-Signature: v1=<hex hmac>).
      const url = config.url ?? '';
      if (!url) throw new ApiError('VALIDATION_ERROR', 'webhook needs config.url', 400);
      const body = {
        event: payload.event ?? 'run.update',
        title: payload.title,
        markdown: trunc(payload.markdown, 3000),
        ...(payload.runUrl ? { runUrl: payload.runUrl } : {}),
      };
      const raw = JSON.stringify(body);
      const headers: Record<string, string> = { 'X-VV-Event': body.event };
      const secret = secrets.signingSecret ?? '';
      if (secret) {
        const { createHmac } = await import('node:crypto');
        headers['X-VV-Signature'] = `v1=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`;
      }
      const r = await postJson(url, { headers, body: JSON.parse(raw) as unknown });
      if (r.status < 200 || r.status >= 300) {
        throw new ApiError('VALIDATION_ERROR', `webhook rejected the event (HTTP ${r.status}): ${r.text.slice(0, 300)}`, 400);
      }
      return { ok: true, provider };
    }
    default:
      throw new ApiError('VALIDATION_ERROR', `unknown provider ${String(provider)}`, 400);
  }
}

export interface BugContext {
  testName: string;
  runId: string;
  status: string;
  browser: string;
  environment?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  errorSummary?: string | null;
  steps: Array<{ stepId: string; name?: string | null; status: string; errorMessage?: string | null; durationMs?: number | null }>;
  artifacts: Array<{ type: string; path: string; mimeType?: string | null; sizeBytes?: number | null }>;
}

/** Deterministic markdown bug report from a terminal run (no secrets inside). */
export function buildBugMarkdown(ctx: BugContext): { title: string; markdown: string } {
  const failed = ctx.steps.filter((s) => s.status === 'failed');
  const title = `[${ctx.status.toUpperCase()}] ${ctx.testName} (${ctx.browser})`;
  const lines: string[] = [
    `## Summary`,
    `- Test: ${ctx.testName}`,
    `- Run: \`${ctx.runId}\` · status \`${ctx.status}\` · browser \`${ctx.browser}\``,
    `- Environment: ${ctx.environment ?? '—'}`,
    `- Started: ${ctx.startedAt ?? '—'} · duration: ${ctx.durationMs ?? '—'}ms`,
    ``,
    `## Error`,
    '```',
    (ctx.errorSummary ?? '(no error summary)').slice(0, 2000),
    '```',
    ``,
    `## Failed steps (${failed.length})`,
  ];
  for (const s of failed.slice(0, 10)) {
    lines.push(`- \`${s.stepId}\` ${s.name ?? ''} (${s.durationMs ?? '—'}ms)`);
    if (s.errorMessage) {
      lines.push('```');
      lines.push(s.errorMessage.slice(0, 1000));
      lines.push('```');
    }
  }
  if (ctx.artifacts.length > 0) {
    lines.push(``, `## Artifacts`);
    for (const a of ctx.artifacts) {
      lines.push(`- ${a.type}: \`${a.path}\`${a.sizeBytes ? ` (${a.sizeBytes} bytes)` : ''}`);
    }
  }
  lines.push(``, `_Generated by SiroTest bug-from-failure._`);
  return { title, markdown: lines.join('\n') };
}
