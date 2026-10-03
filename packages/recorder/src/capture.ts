/**
 * capture.ts — allowlist-only raw event -> captured step.
 * Spec: 04-recorder/recorder-spec.md
 *  - capture: navigation, click/dblclick, input/change, select,
 *    checkbox/radio, meaningful keys, hover (optional).
 *  - NEVER capture: mousemove, mouseover/out (unless hover mode),
 *    focus, blur, scroll, pointermove.
 *  - mask password/sensitive AT CAPTURE time.
 */
import { nanoid } from 'nanoid';
import type { BridgeEvent, CapturedStep } from './types.js';

const IGNORED_KINDS = new Set([
  'mousemove',
  'mouseover',
  'mouseout',
  'pointermove',
  'pointerover',
  'focus',
  'blur',
  'scroll',
  'pointerdown',
  'pointerup',
]);

/** Keys worth recording as `press`. Plain character typing is covered by fill. */
const MEANINGFUL_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
  'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

const SENSITIVE_HINT = /(pass|pwd|secret|token|otp|pin|cvv|card)/i;

export function isSensitiveField(e: BridgeEvent): boolean {
  if (e.maybeSensitive) return true;
  if ((e.inputType ?? '').toLowerCase() === 'password') return true;
  if (e.tag === 'INPUT' && SENSITIVE_HINT.test(e.nameHint ?? '')) return true;
  return false;
}

export function maskValue(value: string | undefined): string {
  if (value == null) return '';
  return '***MASKED***';
}

function elementKey(e: BridgeEvent): string {
  // Fingerprint for debounce only — resolved to a real locator server-side.
  // Uses stable hints + point bucket, never a selector string.
  const px = e.point ? Math.round(e.point.x / 4) : 0;
  const py = e.point ? Math.round(e.point.y / 4) : 0;
  return [e.tag ?? '?', e.inputType ?? '', e.nameHint ?? '', `${px}:${py}`, e.url].join('|');
}

export interface CaptureOptions {
  includeHover?: boolean;
}

export function captureBridgeEvent(
  raw: Record<string, unknown>,
  opts: CaptureOptions = {},
): CapturedStep | null {
  const kind = (raw as { kind?: string }).kind ?? '';
  if (IGNORED_KINDS.has(kind)) return null;

  const e = raw as unknown as BridgeEvent;
  if (!e.kind || !e.url || typeof e.t !== 'number') return null;

  const now = Date.now();
  const at = Number.isFinite(e.t) ? e.t : now;
  const key = elementKey(e);
  const sensitive = isSensitiveField(e);

  switch (e.kind) {
    case 'navigation': {
      // Only real web targets become goto steps:
      // - about:blank is the browser's initial state (racy, meaningless);
      // - browser-internal/error schemes (chrome-error://, chrome://, edge://,
      //   data:, ...) are failure artifacts, never test intent.
      if (!e.url || e.url === 'about:blank') return null;
      let protocol = '';
      try {
        protocol = new URL(e.url).protocol;
      } catch {
        return null;
      }
      if (protocol !== 'http:' && protocol !== 'https:') return null;
      return { id: nanoid(10), type: 'goto', url: e.url, at, elementKey: `nav|${e.url}`, value: e.url };
    }

    case 'click': {
      // Checkbox/radio clicks are normalized to check/uncheck via `checked`.
      if (e.inputType === 'checkbox' || e.inputType === 'radio') {
        return {
          id: nanoid(10),
          type: e.checked ? 'check' : 'uncheck',
          url: e.url, at, elementKey: key, checked: e.checked,
        };
      }
      return { id: nanoid(10), type: 'click', url: e.url, at, elementKey: key };
    }

    case 'dblclick':
      return { id: nanoid(10), type: 'doubleClick', url: e.url, at, elementKey: key };

    case 'input':
    case 'change': {
      // Select elements arrive as select; checkbox/radio as check/uncheck.
      if (e.tag === 'SELECT' || e.selectedValue !== undefined) {
        return {
          id: nanoid(10), type: 'select', url: e.url, at,
          elementKey: key, value: e.selectedValue ?? e.value ?? '',
        };
      }
      if (e.inputType === 'checkbox' || e.inputType === 'radio') {
        return {
          id: nanoid(10),
          type: e.checked ? 'check' : 'uncheck',
          url: e.url, at, elementKey: key, checked: e.checked,
        };
      }
      return {
        id: nanoid(10), type: 'fill', url: e.url, at, elementKey: key,
        value: sensitive ? maskValue(e.value) : (e.value ?? ''),
        sensitive: sensitive || undefined,
      };
    }

    case 'select':
      return {
        id: nanoid(10), type: 'select', url: e.url, at,
        elementKey: key, value: e.selectedValue ?? e.value ?? '',
      };

    case 'check':
      return {
        id: nanoid(10),
        type: e.checked === false ? 'uncheck' : 'check',
        url: e.url, at, elementKey: key, checked: e.checked,
      };

    case 'keydown': {
      const k = e.key ?? '';
      if (k.length === 1 && !MEANINGFUL_KEYS.has(k)) return null; // plain typing -> fill
      if (!MEANINGFUL_KEYS.has(k)) return null;
      return { id: nanoid(10), type: 'press', url: e.url, at, elementKey: key, key: k };
    }

    case 'hover':
      if (!opts.includeHover) return null;
      return { id: nanoid(10), type: 'hover', url: e.url, at, elementKey: key };

    default:
      return null;
  }
}
