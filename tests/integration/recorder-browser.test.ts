/**
 * Integration: live-browser recorder (04-recorder + 05-locator, real Chromium).
 *
 * Drives the fixture login app through a launched recorder browser (the
 * bridge captures DOM events like a human would) and asserts the drafts
 * carry server-resolved semantic locators (label/role primaries).
 *
 * Run: npx tsx --test tests/integration/recorder-browser.test.ts
 * Requires a Playwright chromium binary (CI installs it before this step).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecorderSessionManager } from '../../packages/recorder/src/sessionManager.js';
import { launchRecorderBrowser, type RecorderBrowser } from '../../packages/recorder/src/browser.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(resolve(ROOT, 'apps', 'fixture', 'login.html'), 'utf8');

let http: Server;
let baseUrl = '';
let manager: RecorderSessionManager;

async function waitFor(
  cond: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(async () => {
  await new Promise<void>((resolveReady) => {
    http = createServer((req, res) => {
      if ((req.url ?? '/').startsWith('/login')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(HTML);
      } else {
        res.writeHead(404).end('not found');
      }
    }).listen(0, '127.0.0.1', () => resolveReady());
  });
  const addr = http.address();
  assert.ok(addr && typeof addr === 'object', 'fixture server bound');
  baseUrl = `http://127.0.0.1:${(addr as { port: number }).port}`;
  manager = new RecorderSessionManager();
});

after(async () => {
  await new Promise<void>((r) => http.close(() => r()));
});

async function startLiveSession(): Promise<{ sessionId: string; browser: RecorderBrowser }> {
  const session = manager.start({ userId: 'u_browser', testId: 't_browser_login', projectId: 'p_browser' });
  const browser = await launchRecorderBrowser({
    headed: false,
    baseUrl: `${baseUrl}/login`,
    events: {
      onBridgeEvent: (evt) => {
        void (async () => {
          try {
            const live = manager.getBySessionId(session.sessionId);
            if (!live || live.status !== 'active') return;
            let locator: { primary: unknown; alternatives?: unknown[] } | undefined;
            if (evt.kind !== 'navigation' && evt.kind !== 'keydown') {
              const resolved = await browser.resolveFromEvent(evt);
              if (resolved) locator = { primary: resolved.primary, alternatives: resolved.alternatives };
            }
            manager.ingestResolved(session.sessionId, evt, locator);
          } catch {
            // Host errors must never break the test's browser.
          }
        })();
      },
      onClose: (reason) => {
        try {
          manager.markInterrupted(session.sessionId, reason);
        } catch {
          // Session already stopped — fine.
        }
      },
    },
  });
  manager.attachBrowser(session.sessionId, browser);
  return { sessionId: session.sessionId, browser };
}

describe('live recorder captures a clean login flow', () => {
  it('records goto + fills + click with semantic locators', async () => {
    const { sessionId, browser } = await startLiveSession();
    try {
      const page = browser.page;
      await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Email').fill('tester@example.com');
      await page.getByLabel('Password').fill('s3cr3t!');
      await page.getByRole('button', { name: 'Login' }).click();
      // The trailing step may still sit in the normalizer's pending buffer
      // (collapse window); visible steps = flushed drafts + pending.
      const visible = () => {
        const s = manager.getBySessionId(sessionId);
        if (!s) return [];
        return [...s.draftSteps, ...manager.pendingSteps(sessionId)];
      };
      await waitFor(
        () => visible().some((s) => s.type === 'click'),
        15000,
        'click step to be captured',
      );
      const stopped = manager.stop(sessionId);
      const types = stopped.draftSteps.map((s) => s.type);
      assert.ok(types.includes('goto'), `expected a goto step, got [${types.join(', ')}]`);
      assert.ok(types.includes('fill'), `expected fill steps, got [${types.join(', ')}]`);
      assert.ok(types.includes('click'), `expected a click step, got [${types.join(', ')}]`);

      const fills = stopped.draftSteps.filter((s) => s.type === 'fill');
      assert.ok(fills.length >= 1, 'typing collapses into fill steps');
      // Priority order puts role+name above label — either primary is correct
      // as long as it references the Email field (alternatives keep the rest).
      const mentionsEmail = (loc: unknown): boolean => {
        const l = loc as { primary?: Record<string, unknown>; alternatives?: Record<string, unknown>[] } | undefined;
        const texts = [l?.primary, ...(l?.alternatives ?? [])].map((c) => JSON.stringify(c ?? {}));
        return texts.some((t) => t.includes('Email'));
      };
      const emailFill = fills.find((s) => mentionsEmail(s.locator));
      assert.ok(emailFill, `email fill should reference the Email field, got ${JSON.stringify(fills.map((s) => s.locator))}`);
      const emailPrimary = (emailFill.locator as { primary: Record<string, unknown> }).primary;
      assert.ok(
        (emailPrimary['strategy'] === 'role' && emailPrimary['name'] === 'Email') ||
          (emailPrimary['strategy'] === 'label' && emailPrimary['value'] === 'Email'),
        `email primary should be role+name or label, got ${JSON.stringify(emailPrimary)}`,
      );
      const secretFill = fills.find((s) => s.sensitive === true);
      assert.ok(secretFill, 'password input must be captured as sensitive');
      assert.equal(secretFill.value, '***MASKED***', 'sensitive value masked at capture');

      const click = stopped.draftSteps.find((s) => s.type === 'click');
      const primary = (click?.locator as { primary?: Record<string, unknown> } | undefined)?.primary;
      // Any stable primary is correct: role+name (semantic) or testId.
      // Brittle fallbacks (long css chain, xpath) must never win.
      assert.ok(
        (primary?.['strategy'] === 'role' && primary?.['name'] === 'Login') ||
          (primary?.['strategy'] === 'testId' && primary?.['value'] === 'login-submit'),
        `login click should resolve a stable primary, got ${JSON.stringify(primary)}`,
      );
    } finally {
      await manager.closeBrowser(sessionId).catch(() => undefined);
    }
  });

  it('live Test Locator counts 0/1/N against the page', async () => {
    const { sessionId, browser } = await startLiveSession();
    try {
      await browser.page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      const unique = await browser.testLocator({ strategy: 'label', value: 'Email' });
      assert.equal(unique.matchCount, 1);
      const none = await browser.testLocator({ strategy: 'label', value: 'No Such Field' });
      assert.equal(none.matchCount, 0);
      assert.equal(none.canSave, false);
      const multi = await browser.testLocator({ strategy: 'role', role: 'button' });
      assert.ok(multi.matchCount >= 1, 'role=button matches at least the login button');
      manager.stop(sessionId);
    } finally {
      await manager.closeBrowser(sessionId).catch(() => undefined);
    }
  });

  it('browser death marks the session interrupted and keeps drafts', async () => {
    const { sessionId, browser } = await startLiveSession();
    await browser.page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
    await browser.page.getByLabel('Email').fill('tester@example.com');
    await waitFor(
      () => (manager.getBySessionId(sessionId)?.draftSteps.length ?? 0) > 0,
      15000,
      'draft steps to exist before killing the browser',
    );
    await browser.close('test-kill');
    const s = manager.getBySessionId(sessionId);
    assert.ok(s, 'session stays retrievable after browser death');
    assert.equal(s.status, 'interrupted');
    assert.ok(s.draftSteps.length > 0, 'drafts preserved');
    assert.equal(s.interruptReason, 'test-kill');
    await manager.closeBrowser(sessionId).catch(() => undefined);
  });
});
