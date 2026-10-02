/**
 * Locator engine P0 tests (node:test, no extra runner deps).
 * Covers: scoring priority/bonuses/penalties, candidate generation,
 * expression mapping, resolveLocator output, 0/1/N Test Locator,
 * and the P0 no-self-heal execution gate.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ElementMetadata,
  LocatorCandidate,
} from '../src/types';
import {
  SCORING_RULES,
  isDynamicToken,
  isStableText,
  rankCandidates,
  scoreCandidate,
} from '../src/scoring';
import { buildCandidates, resolveLocator } from '../src/candidates';
import {
  candidateToExpression,
  previewCandidate,
} from '../src/toExpression';
import {
  pickPrimaryForExecution,
  testLocatorMatch,
} from '../src/index';

// ---------------------------------------------------------------- fixtures

const loginButtonMeta: ElementMetadata = {
  tagName: 'button',
  role: 'button',
  accessibleName: 'Đăng nhập',
  testId: 'login-submit',
  text: 'Đăng nhập',
  classNames: ['btn', 'btn-primary'],
  cssPath: '#login-form button.btn-primary',
  xpath: '/html/body/div[1]/main/form/button',
};

const emailMeta: ElementMetadata = {
  tagName: 'input',
  label: 'Email',
  placeholder: 'you@example.com',
  testId: 'login-email',
  id: 'email',
  attributes: { 'data-field': 'email' },
  cssPath: '#login-form > div:nth-child(1) > input',
  xpath: '/html/body/div[1]/main/form/div[1]/input',
};

const passwordMeta: ElementMetadata = {
  tagName: 'input',
  label: 'Mật khẩu',
  placeholder: '••••••••',
  testId: 'login-password',
  attributes: { type: 'password' },
  cssPath: '#login-form > div:nth-child(2) > input',
  xpath: '/html/body/div[1]/main/form/div[2]/input',
};

/** Full candidate set for the login button, all assumed unique. */
function loginButtonSet(): LocatorCandidate[] {
  return buildCandidates(loginButtonMeta);
}

// ---------------------------------------------------------------- scoring

describe('scoring priority', () => {
  it('ranks Role+name > Label > Placeholder > TestId > Text > stable CSS > XPath when all unique', () => {
    const candidates: LocatorCandidate[] = [
      { strategy: 'xpath', value: '/html/body/div[1]/main/form/button' },
      { strategy: 'css', value: '#login-form button.btn-primary' },
      { strategy: 'text', value: 'Đăng nhập' },
      { strategy: 'testId', value: 'login-submit' },
      { strategy: 'placeholder', value: 'you@example.com' },
      { strategy: 'label', value: 'Email' },
      { strategy: 'role', role: 'button', name: 'Đăng nhập' },
    ];
    const ranked = rankCandidates(candidates, () => 1);
    assert.deepEqual(
      ranked.map((r) => r.candidate.strategy),
      ['role', 'label', 'placeholder', 'testId', 'text', 'css', 'xpath'],
    );
  });

  it('role without name scores below testId', () => {
    const noName = scoreCandidate({ strategy: 'role', role: 'button' }).score;
    const testId = scoreCandidate({ strategy: 'testId', value: 'ok' }).score;
    assert.ok(noName < testId, `role w/o name (${noName}) < testId (${testId})`);
  });

  it('uniqueness overrides priority: unique label beats ambiguous role+name', () => {
    const role = scoreCandidate(
      { strategy: 'role', role: 'button', name: 'Đăng nhập' },
      { matchCount: 3 },
    ).score;
    const label = scoreCandidate(
      { strategy: 'label', value: 'Email' },
      { matchCount: 1 },
    ).score;
    assert.ok(label > role, `unique label (${label}) > ambiguous role (${role})`);
  });

  it('zero match is heavily penalized', () => {
    const { score } = scoreCandidate(
      { strategy: 'label', value: 'Email' },
      { matchCount: 0 },
    );
    assert.equal(
      score,
      SCORING_RULES.base.label +
        SCORING_RULES.bonus.semanticAccessible +
        SCORING_RULES.penalty.zeroMatch,
    );
  });
});

describe('scoring bonuses and penalties', () => {
  it('detects dynamic-looking tokens', () => {
    assert.equal(isDynamicToken('login-email'), false);
    assert.equal(isDynamicToken('btn-primary'), false);
    assert.equal(isDynamicToken('css-1a2b3cf9'), true);
    assert.equal(isDynamicToken('a1b2c3d4e5f6'), true);
    assert.equal(isDynamicToken('submit-1698745230123'), true);
    assert.equal(isDynamicToken(':r1:'), true);
  });

  it('penalizes dynamic id/class', () => {
    const stable = scoreCandidate({ strategy: 'css', value: '#login-form button' });
    const dynamic = scoreCandidate({
      strategy: 'css',
      value: '#root div.css-1a2b3c button',
    });
    assert.equal(
      dynamic.score - stable.score,
      SCORING_RULES.penalty.dynamicToken,
    );
  });

  it('strongly penalizes nth-child', () => {
    const plain = scoreCandidate({ strategy: 'css', value: '#login-form input' });
    const nth = scoreCandidate({
      strategy: 'css',
      value: '#login-form > div:nth-child(1) > input',
    });
    assert.ok(nth.score <= plain.score + SCORING_RULES.penalty.nthChild);
  });

  it('strongly penalizes long DOM chains', () => {
    const short = scoreCandidate({ strategy: 'css', value: '#email' });
    const long = scoreCandidate({
      strategy: 'css',
      value: 'html body div.app div.main form#login-form div.row div.col input',
    });
    assert.equal(long.score - short.score, SCORING_RULES.penalty.longDomChain);
  });

  it('xpath is always fallback-lowest', () => {
    const xpath = scoreCandidate(
      { strategy: 'xpath', value: '//button' },
      { matchCount: 1 },
    ).score;
    const css = scoreCandidate(
      { strategy: 'css', value: '#x' },
      { matchCount: 1 },
    ).score;
    assert.ok(xpath < css, `xpath (${xpath}) < css (${css})`);
  });

  it('stable short text earns the text bonus; long/unstable text does not', () => {
    assert.equal(isStableText('Đăng nhập'), true);
    assert.equal(isStableText('x'.repeat(51)), false);
    assert.equal(isStableText('Order 1698745230123'), false);
    const withBonus = scoreCandidate({ strategy: 'text', value: 'Dashboard' });
    const without = scoreCandidate({ strategy: 'text', value: 'x'.repeat(60) });
    assert.equal(
      withBonus.score - without.score,
      SCORING_RULES.bonus.stableShortText,
    );
  });
});

// ---------------------------------------------------------------- candidates

describe('buildCandidates', () => {
  it('emits candidates in priority order and dedupes', () => {
    const keys = buildCandidates(loginButtonMeta).map((c) => c.strategy);
    assert.deepEqual(keys, [
      'role',
      'testId',
      'text',
      'css',
      'css',
      'xpath',
    ]);
  });

  it('skips absurdly long text', () => {
    const out = buildCandidates({ tagName: 'div', text: 'y'.repeat(500) });
    assert.ok(out.every((c) => c.strategy !== 'text'));
  });

  it('throws a helpful error when metadata yields nothing', () => {
    assert.throws(() => resolveLocator({ tagName: 'div' }), /no candidates/);
  });
});

// ------------------------------------------------------- resolve + preview

describe('resolveLocator (login form sample)', () => {
  it('login button resolves to role+name primary with stored alternatives', () => {
    const resolved = resolveLocator(loginButtonMeta, () => 1);
    assert.deepEqual(resolved.primary, {
      strategy: 'role',
      role: 'button',
      name: 'Đăng nhập',
    });
    assert.ok(resolved.alternatives.length >= 3);
    assert.equal(resolved.matchCount, 1);
    assert.equal(resolved.verified, true);
    assert.match(resolved.preview, /getByRole\('button', \{ name: 'Đăng nhập' \}\)/);
    assert.match(resolved.preview, /alternatives \(stored only/);
  });

  it('email input resolves to label primary (label > testId)', () => {
    const resolved = resolveLocator(emailMeta, () => 1);
    assert.deepEqual(resolved.primary, {
      strategy: 'label',
      value: 'Email',
    });
    assert.ok(
      resolved.alternatives.some(
        (a) => a.strategy === 'testId' && a.value === 'login-email',
      ),
    );
  });

  it('password input resolves to label primary', () => {
    const resolved = resolveLocator(passwordMeta, () => 1);
    assert.equal(resolved.primary.strategy, 'label');
  });

  it('unverified resolve marks preview accordingly', () => {
    const resolved = resolveLocator(loginButtonMeta);
    assert.equal(resolved.verified, false);
    assert.match(resolved.preview, /unverified/);
  });

  it('full login set keeps role primary when all unique', () => {
    const ranked = rankCandidates(loginButtonSet(), () => 1);
    assert.equal(ranked[0].candidate.strategy, 'role');
  });
});

// ------------------------------------------------------------- expressions

describe('candidateToExpression', () => {
  it('maps every strategy per the compiler spec', () => {
    const cases: Array<[LocatorCandidate, string]> = [
      [
        { strategy: 'role', role: 'button', name: 'Login' },
        `page.getByRole('button', { name: 'Login' })`,
      ],
      [
        { strategy: 'role', role: 'button', name: 'Login', exact: true },
        `page.getByRole('button', { name: 'Login', exact: true })`,
      ],
      [{ strategy: 'label', value: 'Email' }, `page.getByLabel('Email')`],
      [
        { strategy: 'placeholder', value: 'you@example.com' },
        `page.getByPlaceholder('you@example.com')`,
      ],
      [{ strategy: 'testId', value: 'login-email' }, `page.getByTestId('login-email')`],
      [{ strategy: 'text', value: 'Dashboard' }, `page.getByText('Dashboard')`],
      [{ strategy: 'css', value: '#email' }, `page.locator('#email')`],
      [{ strategy: 'xpath', value: '//button' }, `page.locator('//button')`],
    ];
    for (const [candidate, expected] of cases) {
      assert.equal(candidateToExpression(candidate), expected);
    }
  });

  it('escapes single quotes', () => {
    assert.equal(
      candidateToExpression({ strategy: 'label', value: `l'avis` }),
      `page.getByLabel('l\\'avis')`,
    );
  });

  it('previewCandidate is human-readable', () => {
    assert.equal(
      previewCandidate({ strategy: 'role', role: 'button', name: 'Login' }),
      'role=button name="Login"',
    );
  });
});

// ------------------------------------------------------------------ 0/1/N

describe('testLocatorMatch (0/1/N)', () => {
  it('0 matches: cannot save as healthy', () => {
    const r = testLocatorMatch(0);
    assert.equal(r.status, 'none');
    assert.equal(r.canSave, false);
  });

  it('1 match: unique and healthy', () => {
    const r = testLocatorMatch(1);
    assert.equal(r.status, 'unique');
    assert.equal(r.canSave, true);
    assert.equal(r.warning, undefined);
  });

  it('N matches: ambiguous warning unless multi allowed', () => {
    const strict = testLocatorMatch(4);
    assert.equal(strict.status, 'ambiguous');
    assert.match(strict.warning ?? '', /4 elements/);
    const allowed = testLocatorMatch(4, { allowMultiple: true });
    assert.equal(allowed.warning, undefined);
  });

  it('rejects invalid counts', () => {
    assert.throws(() => testLocatorMatch(-1), /non-negative integer/);
    assert.throws(() => testLocatorMatch(1.5), /non-negative integer/);
  });
});

// ---------------------------------------------------------------- P0 gate

describe('P0 execution gate (no self-heal)', () => {
  it('always runs the stored primary even when it matches 0', () => {
    const broken: LocatorCandidate = { strategy: 'label', value: 'Email' };
    const healthyAlt: LocatorCandidate = {
      strategy: 'testId',
      value: 'login-email',
    };
    const picked = pickPrimaryForExecution({
      primary: broken,
      alternatives: [healthyAlt],
    });
    assert.deepEqual(picked, broken);
  });
});
