/**
 * bridge.ts — injected page script. Sends MINIMAL metadata only.
 * Candidates are computed SERVER-SIDE via Playwright (locator-engine).
 * Never trust selector/xpath strings from page JS.
 */
export const RECORDER_BRIDGE_SOURCE = /* js */ `
(function () {
  if (window.__vvRecorderInstalled) return;
  window.__vvRecorderInstalled = true;
  const q = (window.__vvRecorderQueue = []);
  const send = (msg) => {
    const full = { ...msg, t: Date.now(), url: location.href };
    // Prefer the host binding (reliable, no postMessage round-trip); fall
    // back to the queue + postMessage for externally-driven pages.
    try {
      if (typeof window.vvRecord === 'function') { window.vvRecord(full); return; }
    } catch { /* fall through to queue */ }
    q.push(full);
    window.postMessage({ __vvRecorder: true, evt: full }, '*');
  };
  const hint = (el) => ({
    tag: el.tagName,
    inputType: el.getAttribute && el.getAttribute('type'),
    nameHint: (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || (el.textContent || '').trim().slice(0, 60))) || undefined,
    maybeSensitive: !!el.closest && !!el.closest('input[type="password"]') || (el.getAttribute && el.getAttribute('type') === 'password'),
  });
  // Full element metadata, captured SYNCHRONOUSLY at event time (in-page).
  // The host must not re-query the element later: the page may already have
  // changed (e.g. form submit swaps the view before async resolution runs).
  const richMeta = (el) => {
    try {
      const get = (n) => el.getAttribute(n);
      const tag = el.tagName;
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      let label = '';
      try {
        if (el.labels && el.labels.length > 0) label = (el.labels[0].innerText || '').trim();
        if (!label && el.id) {
          const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (lab) label = (lab.innerText || '').trim();
        }
        if (!label && get('aria-labelledby')) {
          label = get('aria-labelledby').split(/\s+/).map((id) => {
            const n = document.getElementById(id);
            return n ? (n.innerText || '').trim() : '';
          }).filter(Boolean).join(' ');
        }
      } catch { /* best effort */ }
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
      const name = (get('aria-label') || label || get('placeholder') || get('alt') || get('title') ||
        ((tag === 'BUTTON' || tag === 'A') ? text : '') ||
        ((tag === 'INPUT' && (get('type') === 'submit' || get('type') === 'button')) ? (el.value || text) : '')).trim().slice(0, 120);
      const attrs = {};
      for (const a of ['type', 'name', 'placeholder', 'aria-label', 'role', 'data-testid', 'href', 'title', 'alt', 'value']) {
        const v = get(a);
        if (v != null && v !== '') attrs[a] = String(v).slice(0, 200);
      }
      const classNames = (el.className && typeof el.className === 'string' ? el.className : '').split(/\s+/).filter(Boolean).slice(0, 12);
      const parts = [];
      let node = el;
      for (let d = 0; d < 6 && node instanceof Element; d++) {
        let part = node.tagName.toLowerCase();
        if (node.id && /^[A-Za-z][\w:-]*$/.test(node.id)) { parts.unshift('#' + node.id); break; }
        const parent = node.parentElement;
        if (parent) {
          const same = [...parent.children].filter((c) => c.tagName === node.tagName);
          if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      // absolute xpath (fallback only — scored down by the engine)
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
        cssPath: parts.join(' > ') || undefined,
        xpath: '/html/' + xp.join('/'),
      };
    } catch {
      return undefined;
    }
  };
  const pt = (ev) => ({ x: ev.clientX, y: ev.clientY });

  document.addEventListener('click', (ev) => {
    const el = ev.target;
    if (!(el instanceof Element)) return;
    const h = hint(el);
    send({ kind: 'click', ...h, meta: richMeta(el), point: pt(ev), checked: el.checked });
  }, true);

  document.addEventListener('dblclick', (ev) => {
    const el = ev.target;
    if (!(el instanceof Element)) return;
    send({ kind: 'dblclick', ...hint(el), meta: richMeta(el), point: pt(ev) });
  }, true);

  document.addEventListener('input', (ev) => {
    const el = ev.target;
    if (!(el instanceof Element)) return;
    const h = hint(el);
    // send length-bounded value; server masks if sensitive. No selectors sent.
    send({ kind: 'input', ...h, meta: richMeta(el), value: String(el.value ?? '').slice(0, 2000) });
  }, true);

  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (!(el instanceof Element)) return;
    const h = hint(el);
    const meta = richMeta(el);
    if (el.tagName === 'SELECT') send({ kind: 'select', ...h, meta, selectedValue: el.value });
    else if (el.type === 'checkbox' || el.type === 'radio') send({ kind: 'check', ...h, meta, checked: el.checked });
    else send({ kind: 'change', ...h, meta, value: String(el.value ?? '').slice(0, 2000) });
  }, true);

  document.addEventListener('keydown', (ev) => {
    send({ kind: 'keydown', key: ev.key, tag: document.activeElement?.tagName });
  }, true);

  // hover is opt-in (host sets window.__vvIncludeHover): throttled mouseover.
  let lastHover = 0;
  let lastHoverKey = '';
  document.addEventListener('mouseover', (ev) => {
    if (!window.__vvIncludeHover) return;
    const el = ev.target;
    if (!(el instanceof Element)) return;
    const now = Date.now();
    const key = el.tagName + '|' + (el.getAttribute('aria-label') || el.textContent || '').slice(0, 40);
    if (now - lastHover < 600 || key === lastHoverKey) return;
    lastHover = now;
    lastHoverKey = key;
    send({ kind: 'hover', ...hint(el), meta: richMeta(el), point: pt(ev) });
  }, true);

  // navigation: full loads + SPA transitions
  window.addEventListener('load', () => send({ kind: 'navigation' }), true);
  ['pushState', 'replaceState'].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function (...args) { const r = orig.apply(this, args); send({ kind: 'navigation' }); return r; };
  });
  window.addEventListener('popstate', () => send({ kind: 'navigation' }), true);
  window.addEventListener('hashchange', () => send({ kind: 'navigation' }), true);
})();
`;

export function bridgeInstallSnippet(): string {
  return RECORDER_BRIDGE_SOURCE;
}
