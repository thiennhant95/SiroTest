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
    q.push({ ...msg, t: Date.now(), url: location.href });
    window.postMessage({ __vvRecorder: true, evt: q[q.length - 1] }, '*');
  };
  const hint = (el) => ({
    tag: el.tagName,
    inputType: el.getAttribute && el.getAttribute('type'),
    nameHint: (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || (el.textContent || '').trim().slice(0, 60))) || undefined,
    maybeSensitive: !!el.closest && !!el.closest('input[type="password"]') || (el.getAttribute && el.getAttribute('type') === 'password'),
  });
  const pt = (ev) => ({ x: ev.clientX, y: ev.clientY });

  document.addEventListener('click', (ev) => {
    const el = ev.target;
    if (!(el instanceof Element)) return;
    const h = hint(el);
    send({ kind: 'click', ...h, point: pt(ev), checked: el.checked });
  }, true);

  document.addEventListener('dblclick', (ev) => {
    const el = ev.target;
    if (!(el instanceof Element)) return;
    send({ kind: 'dblclick', ...hint(el), point: pt(ev) });
  }, true);

  document.addEventListener('input', (ev) => {
    const el = ev.target;
    if (!(el instanceof Element)) return;
    const h = hint(el);
    // send length-bounded value; server masks if sensitive. No selectors sent.
    send({ kind: 'input', ...h, value: String(el.value ?? '').slice(0, 2000) });
  }, true);

  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (!(el instanceof Element)) return;
    const h = hint(el);
    if (el.tagName === 'SELECT') send({ kind: 'select', ...h, selectedValue: el.value });
    else if (el.type === 'checkbox' || el.type === 'radio') send({ kind: 'check', ...h, checked: el.checked });
    else send({ kind: 'change', ...h, value: String(el.value ?? '').slice(0, 2000) });
  }, true);

  document.addEventListener('keydown', (ev) => {
    send({ kind: 'keydown', key: ev.key, tag: document.activeElement?.tagName });
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
