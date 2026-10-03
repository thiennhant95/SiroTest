/**
 * Shared recorder types. Mirrors 04-recorder/recorder-spec.md + 03-test-model/step-catalog.md.
 */

// ---- Minimal metadata sent by the injected bridge script ----
// NOTE: bridge must NOT send selector/xpath/css strings. Candidates are
// computed server-side via Playwright DOM/ARIA analysis (05-locator).
export type BridgeEventKind =
  | 'navigation'
  | 'click'
  | 'dblclick'
  | 'input'
  | 'change'
  | 'select'
  | 'check'
  | 'keydown'
  | 'hover';

export interface BridgeEvent {
  kind: BridgeEventKind;
  /** page URL at event time */
  url: string;
  /** timestamp ms (client clock) */
  t: number;
  /** uppercased tag name, e.g. INPUT / BUTTON / A / SELECT */
  tag?: string;
  /** input type attr, e.g. text/password/checkbox/radio */
  inputType?: string;
  /** name/id/placeholder/label hints — hints only, never trusted as locator */
  nameHint?: string;
  /** raw value for text inputs (server masks if sensitive) */
  value?: string;
  /** for select */
  selectedValue?: string;
  /** for checkbox/radio */
  checked?: boolean;
  /** for keydown */
  key?: string;
  /** element footprint used by server to resolve the node via Playwright, not a selector */
  point?: { x: number; y: number };
  /** true when element is password-like (set by bridge, re-checked on server) */
  maybeSensitive?: boolean;
  /**
   * Full element metadata captured synchronously in-page at event time.
   * Preferred over point re-resolution (the page may change before the host
   * evaluates). Shape mirrors locator-engine ElementMetadata; never contains
   * trusted selectors — candidates are still computed server-side.
   */
  meta?: Record<string, unknown>;
}

// Server-side captured step (normalized later into a TestDefinition step)
export type CapturedStepType =
  | 'goto'
  | 'click'
  | 'doubleClick'
  | 'fill'
  | 'press'
  | 'check'
  | 'uncheck'
  | 'select'
  | 'hover'
  | 'assertVisible'
  | 'assertText'
  | 'assertURL'
  | 'assertTitle'
  | 'assertValue'
  | 'assertChecked';

export interface CapturedStep {
  id: string;
  type: CapturedStepType;
  url: string;
  at: number;
  /** opaque element fingerprint for debounce/collapse (NOT a persisted locator) */
  elementKey: string;
  value?: string;
  sensitive?: boolean;
  key?: string;
  checked?: boolean;
  /** server locator engine fills this in; bridge never provides it */
  locator?: unknown;
  meta?: Record<string, unknown>;
}

export type SessionStatus =
  | 'active'
  | 'paused'
  | 'stopped'
  | 'interrupted';

export interface RecorderSession {
  sessionId: string;
  testId: string;
  userId: string;
  projectId: string;
  status: SessionStatus;
  startedAt: number;
  updatedAt: number;
  draftSteps: CapturedStep[];
  /** paused buffers raw events instead of dropping them */
  bufferedWhilePaused: BridgeEvent[];
  pickMode: 'off' | 'locator' | 'assertion';
  includeHover: boolean;
  interruptReason?: string;
}
