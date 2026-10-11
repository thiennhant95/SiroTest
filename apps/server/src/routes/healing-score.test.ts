/**
 * Unit: deterministic healing proposal scoring (review aid, never applies).
 * Run: npx tsx --test apps/server/src/routes/healing-score.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreHealingEvidence } from './healing.js';

describe('scoreHealingEvidence', () => {
  it('perfect evidence scores 100', () => {
    const { score, reasons } = scoreHealingEvidence(
      { strategy: 'xpath', value: '//button[1]' },
      { strategy: 'role', role: 'button', name: 'Save' },
      { tried: ['xpath'], matchCount: 1, preview: 'button "Save"', verified: true },
    );
    assert.equal(score, 100);
    assert.ok(reasons.join(' ').includes('strategy change xpath → role'));
  });

  it('unverified ambiguous css evidence scores low', () => {
    const { score } = scoreHealingEvidence(
      { strategy: 'role', role: 'button', name: 'Save' },
      { strategy: 'css', value: '.btn' },
      { tried: ['a', 'b', 'c'], matchCount: 4, verified: false },
    );
    // 0 + 0 + 5 + 4 + 0 = 9
    assert.equal(score, 9);
  });

  it('text winner on second try scores 92', () => {
    const { score } = scoreHealingEvidence(
      { strategy: 'css', value: '#s' },
      { strategy: 'text', value: 'Save' },
      { tried: ['css', 'text'], matchCount: 1, preview: 'ok', verified: true },
    );
    // 40 verified + 30 unique + 10 text + 7 second-try + 5 preview = 92
    assert.equal(score, 92);
  });

  it('empty evidence is explicit, never crashes', () => {
    const { score, reasons } = scoreHealingEvidence({}, {}, {});
    assert.equal(score, 10); // neutral tried-list points only
    assert.ok(reasons.length >= 4);
  });

  it('score is bounded 0–100', () => {
    const { score } = scoreHealingEvidence(null, null, { tried: [], matchCount: 1, preview: 'x', verified: true });
    assert.ok(score >= 0 && score <= 100);
  });
});
