/**
 * Unit: StudioClient — auth header, error mapping, endpoint shapes (mock fetch).
 * Run: npx tsx --test apps/cli/src/api.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StudioApiError, StudioClient, type FetchFn, type MinimalResponse } from './api.js';

const TOKEN = 'secret-token-xyz';

function mockFetch(handler: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => MinimalResponse): FetchFn & { calls: Array<{ url: string; init?: unknown }> } {
  const calls: Array<{ url: string; init?: unknown }> = [];
  const fn = (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as FetchFn & { calls: Array<{ url: string; init?: unknown }> };
  fn.calls = calls;
  return fn;
}

function json(status: number, body: unknown): MinimalResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

describe('StudioClient', () => {
  it('sends Bearer auth and JSON bodies to the run endpoint', async () => {
    const fetch = mockFetch((_url, init) => json(202, { id: 'run_1', status: 'queued' }));
    const client = new StudioClient('http://api:3001/', TOKEN, fetch);
    const run = await client.createTestRun('t1', { environmentId: 'e1', browser: 'chromium', headed: false });
    assert.equal(run.id, 'run_1');
    assert.equal(fetch.calls.length, 1);
    const call = fetch.calls[0]!;
    assert.equal(call.url, 'http://api:3001/api/v1/tests/t1/runs');
    const headers = (call.init as { headers: Record<string, string> }).headers;
    assert.equal(headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(headers['content-type'], 'application/json');
  });
  it('maps server error bodies to readable messages', async () => {
    const fetch = mockFetch(() => json(400, { code: 'VALIDATION_ERROR', message: 'bad env' }));
    const client = new StudioClient('http://api:3001', TOKEN, fetch);
    await assert.rejects(() => client.createTestRun('t1', { environmentId: 'nope', browser: 'chromium', headed: false }), (err: unknown) => {
      assert.ok(err instanceof StudioApiError);
      assert.equal(err.status, 400);
      assert.match(err.message, /VALIDATION_ERROR/);
      assert.match(err.message, /bad env/);
      assert.ok(!err.message.includes(TOKEN), 'token must not leak into errors');
      return true;
    });
  });
  it('wraps network failures without leaking the token', async () => {
    const fetch = mockFetch(() => {
      throw new Error('connect ECONNREFUSED');
    });
    const client = new StudioClient('http://api:3001', TOKEN, fetch);
    await assert.rejects(() => client.getRun('r1'), (err: unknown) => {
      assert.ok(err instanceof StudioApiError);
      assert.match((err as Error).message, /ECONNREFUSED/);
      assert.ok(!(err as Error).message.includes(TOKEN));
      return true;
    });
  });
  it('hits the export endpoints with auth', async () => {
    const fetch = mockFetch(() => ({ ok: true, status: 200, text: async () => '<testsuites/>' }));
    const client = new StudioClient('http://api:3001', TOKEN, fetch);
    const xml = await client.exportRunJUnit('r1');
    assert.equal(xml, '<testsuites/>');
    assert.equal(fetch.calls[0]!.url, 'http://api:3001/api/v1/runs/r1/export?format=junit');
  });
});
