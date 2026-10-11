/**
 * Unit: LLM-assisted suggestions (opt-in extras; rules stay as fallback).
 * Run: npx tsx --test apps/server/src/routes/suggestions-assist.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AIProvider } from '@vv/ai';
import { buildSuggestions, llmAssistSuggestions } from './suggestions.js';

function stubLlm(reply: string | Error): AIProvider {
  return {
    name: 'stub-llm',
    engine: 'llm',
    complete: async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

const STEPS = [
  { id: 's1', type: 'goto', enabled: true, url: 'https://example.com/login' },
  {
    id: 's2', type: 'fill', enabled: true,
    target: { primary: { strategy: 'label', value: 'Email' } },
    value: 'a@b.c',
  },
];

describe('llmAssistSuggestions', () => {
  it('rules-only note when no LLM is configured', async () => {
    const { extra, result } = await llmAssistSuggestions(STEPS, 'proj_x', {
      provider: { name: 'rule-based', engine: 'rules', complete: async () => '' },
      secrets: [],
    });
    assert.deepEqual(extra, []);
    assert.equal(result.engine, 'rules');
    assert.match(result.note, /no LLM is configured/);
  });

  it('accepts valid extras, drops bad refs + invalid steps with counts', async () => {
    const { extra, result } = await llmAssistSuggestions(STEPS, 'proj_x', {
      secrets: [],
      provider: stubLlm(JSON.stringify({
        assertions: [
          { kind: 'assertTitle', afterStepId: 's1', expected: 'Login' },
          { kind: 'assertVisible', afterStepId: 'nope', target: { primary: { strategy: 'text', value: 'x' } } },
          { kind: 'explode', afterStepId: 's1' },
          { kind: 'assertValue', afterStepId: 's2' },
        ],
      })),
    });
    assert.equal(result.engine, 'llm');
    assert.equal(result.added, 1);
    assert.equal(result.dropped, 3);
    assert.equal(extra.length, 1);
    assert.equal(extra[0].kind, 'assertTitle');
    assert.equal(extra[0].engine, 'llm');
    assert.match(extra[0].id, /^sug:llm:s1:assertTitle:1$/);
    assert.match(result.note, /3 failed validation/);
  });

  it('unparseable LLM JSON falls back to rules with an explicit note', async () => {
    const { extra, result } = await llmAssistSuggestions(STEPS, 'proj_x', {
      secrets: [],
      provider: stubLlm('not json at all {{{'),
    });
    assert.deepEqual(extra, []);
    assert.equal(result.engine, 'rules');
    assert.match(result.note, /unparseable JSON/);
  });

  it('LLM errors fall back to rules with an explicit note', async () => {
    const { extra, result } = await llmAssistSuggestions(STEPS, 'proj_x', {
      secrets: [],
      provider: stubLlm(new Error('HTTP 429')),
    });
    assert.deepEqual(extra, []);
    assert.match(result.note, /HTTP 429/);
  });

  it('rule suggestions are engine-tagged rules', () => {
    for (const s of buildSuggestions(STEPS)) {
      assert.equal(s.engine, 'rules');
    }
    assert.ok(buildSuggestions(STEPS).length >= 2);
  });
});
