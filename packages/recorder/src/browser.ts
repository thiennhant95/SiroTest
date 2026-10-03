/**
 * browser.ts — live-browser host for recorder sessions (04-recorder).
 *
 * Launches a real Chromium via Playwright, injects the bridge script with
 * `addInitScript`, and forwards interaction events (plus server-side
 * navigation) into the session manager. Locator candidates are resolved
 * server-side from Playwright DOM/ARIA analysis (05-locator) — the bridge
 * never sends selector strings.
 *
 * Degradation contract: every Playwright call is guarded — a metadata or
 * count failure yields a step WITHOUT a locator (or an unverified resolve),
 * never a dropped session. Test Locator without a live page stays an
 * explicit 503 (route-level), never a fabricated count.
 */
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import {
  buildCandidates,
  candidateKey,
  candidateToExpression,
  resolveLocator,
  testLocatorMatch,
  type ElementMetadata,
  type LocatorCandidate,
  type ResolvedLocator,
  type TestLocatorResult,
} from '@playwright-vv/locator-engine';
import { RECORDER_BRIDGE_SOURCE } from './bridge.js';
import type { BridgeEvent } from './types.js';

export interface RecorderBrowserEvents {
  onBridgeEvent?: (evt: BridgeEvent) => void | Promise<void>;
  onClose?: (reason: string) => void;
}

export interface LaunchRecorderBrowserOptions {
  /** Headed for human interaction; headless for CI/tests. */
  headed?: boolean;
  /** Initial page URL (navigated after the bridge is installed). */
  baseUrl?: string;
  /** Forward hover events (off by default — noisy). */
  includeHover?: boolean;
  events?: RecorderBrowserEvents;
}

/** Rich element metadata evaluated inside the live page (never a selector). */
const METADATA_SOURCE = /* js */ `
(x, y) => {
  const el = document.elementFromPoint(x, y);
  if (!(el instanceof Element)) return null;
  const get = (n) => el.getAttribute(n);
  const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  let label = '';
  try {
    if (el.labels && el.labels.length > 0) label = (el.labels[0].innerText || '').trim();
    if (!label && el.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab) label = (lab.innerText || '').trim();
    }
    if (!label && el.getAttribute('aria-labelledby')) {
      label = el.getAttribute('aria-labelledby').split(/\\s+/).map((id) => {
        const n = document.getElementById(id);
        return n ? (n.innerText || '').trim() : '';
      }).filter(Boolean).join(' ');
    }
  } catch { /* best effort */ }
  const attrs = {};
  for (const a of ['type', 'name', 'placeholder', 'aria-label', 'role', 'data-testid', 'href', 'title', 'alt', 'value']) {
    const v = get(a);
    if (v != null && v !== '') attrs[a] = String(v).slice(0, 200);
  }
  const classNames = (el.className && typeof el.className === 'string' ? el.className : '').split(/\\s+/).filter(Boolean).slice(0, 12);
  // implicit ARIA role approximation (explicit role attr wins downstream)
  const tag = el.tagName;
  const type = (get('type') || '').toLowerCase();
  let implicit = '';
  if (tag === 'BUTTON') implicit = 'button';
  else if (tag === 'A' && get('href')) implicit = 'link';
  else if (tag === 'INPUT' && (type === '' || type === 'text' || type === 'email' || type === 'password' || type === 'search' || type === 'tel' || type === 'url')) implicit = 'textbox';
  else if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) implicit = 'checkbox';
  else if (tag === 'SELECT') implicit = 'combobox';
  else if (tag === 'TEXTAREA') implicit = 'textbox';
  else if (/^H[1-6]$/.test(tag)) implicit = 'heading';
  else if (tag === 'IMG') implicit = 'img';
  // accessible name approximation
  const name = (get('aria-label') || label || get('placeholder') || get('alt') || get('title') ||
    ((tag === 'BUTTON' || tag === 'A') ? text : '') ||
    ((tag === 'INPUT' && (get('type') === 'submit' || get('type') === 'button')) ? (el.value || text) : '')).trim().slice(0, 120);
  // css path (capped, may be unstable — scored down by the engine)
  const parts = [];
  let node = el;
  for (let d = 0; d < 6 && node instanceof Element; d++) {
    let part = node.tagName.toLowerCase();
    if (node.id && /^[A-Za-z][\\w:-]*$/.test(node.id)) { parts.unshift('#' + node.id); break; }
    const parent = node.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === node.tagName);
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  const cssPath = parts.join(' > ');
  // absolute xpath (fallback only)
  const xp = [];
  let xn = el;
  for (let d = 0; d < 8 && xn instanceof Element && xn.tagName !== 'HTML'; d++) {
    const parent = xn.parentElement;
    let idx = 1;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === xn.tagName);
      idx = same.indexOf(xn) + 1;
    }
    xp.unshift(xn.tagName.toLowerCase() + '[' + idx + ']');
    xn = parent;
  }
  return {
    tagName: tag,
    role: get('role') || implicit || undefined,
    accessibleName: name || undefined,
    label: label || undefined,
    placeholder: get('placeholder') || undefined,
    testId: get('data-testid') || undefined,
    text: text || undefined,
    id: get('id') || undefined,
    classNames,
    attributes: attrs,
    cssPath,
    xpath: '/html/' + xp.join('/'),
  };
}
`;

const HIGHLIGHT_SOURCE = /* js */ `
(el) => {
  if (!(el instanceof Element)) return false;
  try { el.scrollIntoView({ block: 'center' }); } catch { /* noop */ }
  const prev = el.style.outline;
  el.style.outline = '3px solid #4f46e5';
  el.dataset.vvHighlight = '1';
  setTimeout(() => { try { if (el.dataset.vvHighlight) { el.style.outline = prev; delete el.dataset.vvHighlight; } } catch {} }, 2500);
  return true;
}
`;

export interface RecorderBrowser {
  page: Page;
  close: (reason?: string) => Promise<void>;
  /** Resolve a locator for a bridge event (event-time metadata preferred). */
  resolveFromEvent: (evt: BridgeEvent) => Promise<ResolvedLocator | null>;
  /** Resolve candidates for the element at a viewport point (null when none). */
  resolveFromPoint: (point: { x: number; y: number }) => Promise<ResolvedLocator | null>;
  /** Live 0/1/N count + highlight for a candidate (05-locator Test Locator). */
  testLocator: (candidate: LocatorCandidate) => Promise<TestLocatorResult & { preview: string }>;
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([p, gate]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * ElementMetadata from the event-time bridge payload (preferred: captured
 * synchronously in-page, immune to post-event DOM swaps). Falls back to
 * null when the event carries no usable metadata.
 */
export function metadataFromEvent(evt: BridgeEvent): ElementMetadata | null {
  const m = evt.meta;
  if (!m || typeof m !== 'object' || typeof (m as Record<string, unknown>)['tagName'] !== 'string') return null;
  const r = m as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
  const arr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 12) : undefined;
  const rec = (v: unknown): Record<string, string> | undefined => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val.slice(0, 200);
    }
    return out;
  };
  return {
    tagName: (r['tagName'] ?? '') as string,
    ...(str(r['role']) ? { role: str(r['role']) } : {}),
    ...(str(r['accessibleName']) ? { accessibleName: str(r['accessibleName']) } : {}),
    ...(str(r['label']) ? { label: str(r['label']) } : {}),
    ...(str(r['placeholder']) ? { placeholder: str(r['placeholder']) } : {}),
    ...(str(r['testId']) ? { testId: str(r['testId']) } : {}),
    ...(str(r['text']) ? { text: str(r['text']) } : {}),
    ...(str(r['id']) ? { id: str(r['id']) } : {}),
    ...(arr(r['classNames']) ? { classNames: arr(r['classNames']) } : {}),
    ...(rec(r['attributes']) ? { attributes: rec(r['attributes']) } : {}),
    ...(str(r['cssPath']) ? { cssPath: str(r['cssPath']) } : {}),
    ...(str(r['xpath']) ? { xpath: str(r['xpath']) } : {}),
  } as ElementMetadata;
}

/** Rank candidates with live browser counts (concurrent; unknown = unverified). */
async function resolveWithCounts(
  page: Page,
  meta: ElementMetadata,
  countFor: (candidate: LocatorCandidate) => Promise<number | undefined>,
): Promise<ResolvedLocator | null> {
  try {
    const candidates = buildCandidates(meta);
    if (candidates.length === 0) return null;
    const settled = await Promise.all(candidates.map((c) => countFor(c)));
    const counts = new Map<string, number>();
    candidates.forEach((c, i) => {
      const n = settled[i];
      if (typeof n === 'number') counts.set(candidateKey(c), n);
    });
    const getCount = counts.size > 0 ? (c: LocatorCandidate): number | undefined => counts.get(candidateKey(c)) : undefined;
    return resolveLocator(meta, getCount);
  } catch {
    return null;
  }
}

/**
 * Build a LIVE Playwright Locator from a candidate (runtime counting and
 * highlighting). This mirrors the codegen mapping in candidateToExpression
 * but calls page.getBy* directly — codegen strings (with the `page.` prefix)
 * are NOT valid page.locator() input.
 */
function locate(page: Page, c: LocatorCandidate): Locator {
  switch (c.strategy) {
    case 'role':
      return c.name !== undefined
        ? page.getByRole(c.role as Parameters<Page['getByRole']>[0], { name: c.name, ...(c.exact !== undefined ? { exact: c.exact } : {}) })
        : page.getByRole(c.role as Parameters<Page['getByRole']>[0]);
    case 'label':
      return page.getByLabel(c.value, { ...(c.exact !== undefined ? { exact: c.exact } : {}) });
    case 'placeholder':
      return page.getByPlaceholder(c.value, { ...(c.exact !== undefined ? { exact: c.exact } : {}) });
    case 'testId':
      return page.getByTestId(c.value);
    case 'text':
      return page.getByText(c.value, { ...(c.exact !== undefined ? { exact: c.exact } : {}) });
    case 'css':
    case 'xpath':
      return page.locator(c.value);
  }
}

export async function launchRecorderBrowser(
  opts: LaunchRecorderBrowserOptions = {},
): Promise<RecorderBrowser> {
  const browser: Browser = await chromium.launch({
    headless: !(opts.headed ?? false),
  });
  let closed = false;
  const fireClose = (reason: string): void => {
    if (closed) return;
    closed = true;
    opts.events?.onClose?.(reason);
  };
  browser.on('disconnected', () => fireClose('browser-disconnected'));

  const context: BrowserContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.exposeBinding('vvRecord', (_source, evt: unknown) => {
    try {
      void opts.events?.onBridgeEvent?.(evt as BridgeEvent);
    } catch {
      // never break the page on a host handling error
    }
  });
  await context.addInitScript(
    `${RECORDER_BRIDGE_SOURCE}\nwindow.__vvIncludeHover = ${opts.includeHover === true ? 'true' : 'false'};`,
  );
  const page = await context.newPage();
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    try {
      void opts.events?.onBridgeEvent?.({ kind: 'navigation', url: frame.url(), t: Date.now() });
    } catch {
      // noop
    }
  });
  page.on('close', () => fireClose('page-closed'));

  if (opts.baseUrl) {
    await page.goto(opts.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {
      // baseUrl unreachable at start is not fatal — the user can navigate.
    });
  }

  const countFor = async (candidate: LocatorCandidate): Promise<number | undefined> => {
    try {
      const n = await withTimeout(locate(page, candidate).count(), 2500, undefined);
      return typeof n === 'number' ? n : undefined;
    } catch {
      return undefined;
    }
  };

  const resolveFromPointImpl = async (point: { x: number; y: number }): Promise<ResolvedLocator | null> => {
    try {
      // METADATA_SOURCE is an arrow-function expression: invoke it with the
      // point (page.evaluate of a bare function would return the function).
      const meta = (await withTimeout(
        page.evaluate(`(${METADATA_SOURCE})(${Number(point.x)}, ${Number(point.y)})`),
        4000,
        null,
      )) as ElementMetadata | null;
      if (!meta || !meta.tagName) return null;
      return resolveWithCounts(page, meta, countFor);
    } catch {
      return null;
    }
  };

  return {
    page,
    close: async (reason = 'session-stopped'): Promise<void> => {
      fireClose(reason);
      await browser.close().catch(() => undefined);
    },
    /**
     * Resolve a locator for a bridge event. Prefers the event-time metadata
     * captured synchronously in-page (immune to post-event DOM swaps);
     * falls back to point re-resolution for metadata-less events.
     */
    resolveFromEvent: async (evt: BridgeEvent) => {
      const atCapture = metadataFromEvent(evt);
      if (atCapture) {
        const withCounts = await resolveWithCounts(page, atCapture, countFor);
        if (withCounts) return withCounts;
      }
      if (evt.point) return resolveFromPointImpl(evt.point);
      return null;
    },
    resolveFromPoint: async (point) => resolveFromPointImpl(point),
    testLocator: async (candidate) => {
      const matchCount = await countFor(candidate);
      const count = typeof matchCount === 'number' ? matchCount : 0;
      if (count === 1) {
        try {
          const handles = await locate(page, candidate).elementHandles();
          const first = handles[0];
          if (first) await first.evaluate(HIGHLIGHT_SOURCE).catch(() => undefined);
        } catch {
          // highlight is best effort
        }
      }
      const verdict = testLocatorMatch(count);
      return { ...verdict, preview: candidateToExpression(candidate) };
    },
  };
}
