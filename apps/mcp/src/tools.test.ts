import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFS } from './tools.js';
import { StudioApiError, type FetchFn } from './client.js';
import { StudioClient } from './client.js';

function stubFetch(routes: Record<string, { status: number; body: unknown }>): FetchFn {
  return async (url, init) => {
    const u = new URL(url);
    const key = `${init?.method ?? 'GET'} ${u.pathname}${u.search}`;
    const hit = routes[key];
    if (!hit) return { ok: false, status: 404, text: async () => '{"code":"NOT_FOUND","message":"no stub"}' };
    return { ok: hit.status >= 200 && hit.status < 300, status: hit.status, text: async () => JSON.stringify(hit.body) };
  };
}

function textOf(r: { content: [{ text: string }] }): { ok: boolean; result?: unknown; error?: string } {
  return JSON.parse(r.content[0].text) as { ok: boolean; result?: unknown; error?: string };
}

describe('mcp tools', () => {
  it('registers the control-plane tool set (no destructive review tools)', () => {
    const names = TOOL_DEFS.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'studio_create_run',
      'studio_explain_run',
      'studio_export_spec',
      'studio_get_run',
      'studio_get_test',
      'studio_list_healing',
      'studio_list_projects',
      'studio_list_tests',
      'studio_parse_gherkin',
    ]);
  });

  it('lists projects and surfaces API errors explicitly', async () => {
    const okClient = new StudioClient('http://x', 't', stubFetch({
      'GET /api/v1/projects': { status: 200, body: [{ id: 'p1', name: 'Demo' }] },
    }));
    const def = TOOL_DEFS.find((t) => t.name === 'studio_list_projects')!;
    assert.equal(textOf(await def.run(okClient, {})).ok, true);

    const badClient = new StudioClient('http://x', 't', stubFetch({
      'GET /api/v1/projects': { status: 403, body: { code: 'FORBIDDEN', message: 'No access' } },
    }));
    const bad = textOf(await badClient.listProjects().then(
      () => { throw new Error('should throw'); },
      (e: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: (e as StudioApiError).message }) }] }),
    ));
    assert.equal(bad.ok, false);
    assert.match(bad.error!, /FORBIDDEN/);
  });

  it('summarizes tests without dumping the definition by default', async () => {
    const client = new StudioClient('http://x', 't', stubFetch({
      'GET /api/v1/tests/t1': {
        status: 200,
        body: { id: 't1', projectId: 'p1', name: 'T', definitionJson: JSON.stringify({ steps: [{ id: 's1', type: 'goto' }] }) },
      },
    }));
    const def = TOOL_DEFS.find((t) => t.name === 'studio_get_test')!;
    const slim = textOf(await def.run(client, { testId: 't1' }));
    assert.equal(slim.ok, true);
    assert.deepEqual((slim.result as { steps: unknown }).steps, [{ id: 's1', type: 'goto' }]);
    assert.ok(!('definitionJson' in (slim.result as Record<string, unknown>)));
    const full = textOf(await def.run(client, { testId: 't1', includeDefinition: true }));
    assert.ok('definitionJson' in (full.result as Record<string, unknown>));
  });

  it('truncates long step errors in run summaries', async () => {
    const client = new StudioClient('http://x', 't', stubFetch({
      'GET /api/v1/runs/r1': {
        status: 200,
        body: { id: 'r1', status: 'failed', steps: [{ stepId: 's1', status: 'failed', errorMessage: 'E'.repeat(5000) }] },
      },
    }));
    const def = TOOL_DEFS.find((t) => t.name === 'studio_get_run')!;
    const out = textOf(await def.run(client, { runId: 'r1' }));
    const err = (out.result as { steps: Array<{ error: string }> }).steps[0].error;
    assert.ok(err.length < 5000 && err.endsWith('(truncated)'));
  });
});
