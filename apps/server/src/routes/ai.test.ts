/**
 * P2 AI routes — inject tests (no DB paths: status + nl + explain-by-error +
 * cleanup-by-steps). Run: npx tsx --test apps/server/src/routes/ai.test.ts
 *
 * Auth: P0 x-user-id header. AI key is scrubbed for the rules-path tests and
 * faked (no network: status never calls the provider) for the llm-path test.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { ensureIntegrationDb } from '../../../../tests/integration/helpers.js';
import { aiRoutes } from './ai.js';

process.env.SKIP_LISTEN = '1';

let app: FastifyInstance;
let savedKey: string | undefined;
let hadKey: boolean;

before(async () => {
  // Isolated SQLite file (never dev.db) so the runId/testId 404 paths hit a real schema.
  await ensureIntegrationDb();
  hadKey = Object.prototype.hasOwnProperty.call(process.env, 'AI_API_KEY');
  savedKey = process.env.AI_API_KEY;
  delete process.env.AI_API_KEY;
  app = Fastify({ logger: false });
  await app.register(aiRoutes);
});

after(async () => {
  if (hadKey) process.env.AI_API_KEY = savedKey;
  else delete process.env.AI_API_KEY;
  await app.close();
});

function injectAuthed(method: 'GET' | 'POST', url: string, body?: unknown) {
  const headers: Record<string, string> = { 'x-user-id': 'u_ai_test' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.inject({ method, url, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
}

describe('GET /ai/status', () => {
  it('requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/ai/status' });
    assert.equal(res.statusCode, 401);
  });

  it('reports rules engine without a key (and never leaks one)', async () => {
    const res = await injectAuthed('GET', '/ai/status');
    assert.equal(res.statusCode, 200);
    const body = res.json() as { engine: string; provider: string; model?: string };
    assert.equal(body.engine, 'rules');
    assert.equal(typeof body.provider, 'string');
    assert.ok(!('apiKey' in body) && !('key' in body));
  });

  it('reports llm engine with a key (no network call on status)', async () => {
    process.env.AI_API_KEY = 'sk-fake-status-key';
    try {
      const res = await injectAuthed('GET', '/ai/status');
      assert.equal(res.statusCode, 200);
      const body = res.json() as { engine: string; provider: string; model?: string };
      assert.equal(body.engine, 'llm');
      assert.ok(typeof body.model === 'string' && body.model.length > 0);
      assert.ok(!JSON.stringify(body).includes('sk-fake-status-key'));
    } finally {
      delete process.env.AI_API_KEY;
    }
  });
});

describe('POST /ai/nl-to-steps', () => {
  it('parses a Vietnamese login flow via rules', async () => {
    const res = await injectAuthed('POST', '/ai/nl-to-steps', {
      text: 'Mở trang https://example.com\nNhập "a@b.c" vào ô "Email"\nNhấn nút "Login"',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { engine: string; steps: Array<{ type: string }>; unparsed: string[] };
    assert.equal(body.engine, 'rules'); // no key → honest rules
    assert.deepEqual(body.steps.map((s) => s.type), ['goto', 'fill', 'click']);
    assert.deepEqual(body.unparsed, []);
  });

  it('returns unparsed explicitly for unknown clauses', async () => {
    const res = await injectAuthed('POST', '/ai/nl-to-steps', {
      text: 'open https://example.com\nperform quantum magic',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { engine: string; steps: unknown[]; unparsed: string[] };
    assert.equal(body.steps.length, 1);
    assert.deepEqual(body.unparsed, ['perform quantum magic']);
  });

  it('rejects empty text with VALIDATION_ERROR', async () => {
    const res = await injectAuthed('POST', '/ai/nl-to-steps', { text: '' });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { code: string }).code, 'VALIDATION_ERROR');
  });
});

describe('POST /ai/explain', () => {
  it('classifies an assertion failure from inline error text', async () => {
    const res = await injectAuthed('POST', '/ai/explain', {
      errorSummary: "expect(locator).toHaveText(expected 'Hi' but received 'Hello')",
      stepType: 'assertText',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      engine: string;
      explanation: { category: string; likelyCauses: string[]; suggestedFixes: string[]; confidence: string };
    };
    assert.equal(body.engine, 'rules');
    assert.equal(body.explanation.category, 'assert-mismatch');
    assert.ok(body.explanation.likelyCauses.length > 0);
    assert.ok(body.explanation.suggestedFixes.length > 0);
  });

  it('classifies a strict-mode locator failure', async () => {
    const res = await injectAuthed('POST', '/ai/explain', {
      errorSummary: "locator.click: strict mode violation: resolved to 2 elements",
      stepType: 'click',
      timeoutMs: 5000,
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { explanation: { category: string } }).explanation.category, 'locator-not-found');
  });

  it('requires runId or errorSummary', async () => {
    const res = await injectAuthed('POST', '/ai/explain', { stepType: 'click' });
    assert.equal(res.statusCode, 400);
  });

  it('404s unknown runId', async () => {
    const res = await injectAuthed('POST', '/ai/explain', { runId: 'run_missing' });
    assert.equal(res.statusCode, 404);
  });
});

describe('POST /ai/cleanup', () => {
  it('merges fills + drops focus click, returning preview changes', async () => {
    const target = { primary: { strategy: 'label', value: 'Email' } };
    const res = await injectAuthed('POST', '/ai/cleanup', {
      steps: [
        { id: 'a', type: 'click', enabled: true, target },
        { id: 'b', type: 'fill', enabled: true, target, value: 't' },
        { id: 'c', type: 'fill', enabled: true, target, value: 'tester@x.com' },
      ],
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      engine: string;
      steps: Array<{ id: string; type: string }>;
      changes: Array<{ kind: string; description: string }>;
    };
    assert.equal(body.engine, 'rules');
    assert.deepEqual(body.steps.map((s) => s.id), ['b']); // click dropped, fills merged
    const kinds = body.changes.map((c) => c.kind);
    assert.ok(kinds.includes('merge-fill'));
    assert.ok(kinds.includes('drop-click-before-fill'));
    assert.ok(kinds.includes('suggest-assertion'));
    assert.ok(body.changes.every((c) => typeof c.description === 'string' && c.description.length > 0));
  });

  it('requires testId or steps', async () => {
    const res = await injectAuthed('POST', '/ai/cleanup', {});
    assert.equal(res.statusCode, 400);
  });

  it('404s unknown testId', async () => {
    const res = await injectAuthed('POST', '/ai/cleanup', { testId: 'test_missing' });
    assert.equal(res.statusCode, 404);
  });
});
