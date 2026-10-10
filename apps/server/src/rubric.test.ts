import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRubric } from './rubric.js';

function step(id: string, type: string, extra: Record<string, unknown> = {}) {
  return { id, type, enabled: true, name: id, ...extra };
}

const label = { primary: { strategy: 'label', value: 'Email' } };
const xpath = { primary: { strategy: 'xpath', value: '//div[1]' } };

describe('rubric (deterministic recording score)', () => {
  it('scores a clean recording near 100', () => {
    const r = scoreRubric({
      steps: [
        step('g1', 'goto', { name: 'Open', url: 'https://x' }),
        step('f1', 'fill', { target: { ...label, alternatives: [{ strategy: 'testId', value: 'e' }] }, value: 'a' }),
        step('c1', 'click', { target: label }),
        step('a1', 'assertVisible', { target: label }),
      ],
    });
    assert.equal(r.maxScore, 100);
    // primaries 30 + alt (1/3 → 5) + no-waits 15 + assert 20 + named 10 + enabled 10
    assert.equal(r.score, 30 + 5 + 15 + 20 + 10 + 10);
  });

  it('penalizes xpath primaries, hard waits, missing assertions and names', () => {
    const r = scoreRubric({
      steps: [
        { id: 's1', type: 'click', enabled: true, target: xpath },
        { id: 's2', type: 'waitForTimeout', enabled: true, milliseconds: 3000 },
        { id: 's3', type: 'goto', enabled: false, url: 'https://x' },
      ],
    });
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    assert.equal(byId['stable-primaries'].earned, 0);
    assert.equal(byId['alternatives'].earned, 0);
    assert.equal(byId['no-hard-waits'].earned, 10);
    assert.equal(byId['assertions'].earned, 0);
    assert.equal(byId['named-steps'].earned, 0);
    assert.equal(r.score, 10 + Math.round((2 / 3) * 10));
  });

  it('scores empty/corrupt definitions 0 without throwing', () => {
    assert.equal(scoreRubric({ steps: [] }).score, 0);
    assert.equal(scoreRubric(null).score, 0);
    assert.equal(scoreRubric({ steps: 'nope' }).score, 0);
  });

  it('is deterministic across calls', () => {
    const def = { steps: [step('a', 'click', { target: xpath })] };
    assert.deepEqual(scoreRubric(def), scoreRubric(def));
  });
});
