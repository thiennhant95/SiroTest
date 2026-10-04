/**
 * P0 server security helpers (11-security/security.md).
 *
 * Centralises the controls the audit requires:
 *  1. Secret encryption at rest (AES-256-GCM, key from env).
 *  2. Masking of secret values in read APIs.
 *  3. SSRF-safe URL validation (allowlist http/https + block private/loopback/link-local).
 *  4. Test-definition validation (step allowlist => arbitrary custom code disabled).
 *  5. Export filename sanitising (header injection) + server-path stripping.
 *  6. Size limits shared by routes and the runner.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const REDACTED = '***';

/** Max JSON body Fastify will accept (upload/artifact size limit, P0). */
export const JSON_BODY_LIMIT = '1mb';
/** Same cap in bytes (wired into Fastify bodyLimit in app.ts). */
export const JSON_BODY_LIMIT_BYTES = 1024 * 1024;
/** Max stored test-definition JSON (bytes). */
export const DEFINITION_JSON_MAX_BYTES = 512 * 1024;
/** Max single artifact file the runner will record (bytes). */
export const ARTIFACT_MAX_BYTES = 50 * 1024 * 1024;
/** Max screenshots recorded per run. */
export const MAX_SCREENSHOTS_PER_RUN = 100;

// ---------------------------------------------------------------------------
// 1. Secret encryption at rest (AES-256-GCM)
// ---------------------------------------------------------------------------

const ENC_PREFIX = 'enc:v1:';

function readKeyBytes(): Buffer | null {
  const raw =
    process.env.SECRET_ENCRYPTION_KEY ?? process.env.SERVER_SECRET_KEY ?? '';
  if (!raw || raw === 'change-me-to-32-bytes-base64-key==') return null;
  // Accept base64 (44 chars for 32 bytes) or 64-char hex or raw 32-byte string.
  try {
    if (/^[A-Za-z0-9+/=]{40,}$/.test(raw)) {
      const b = Buffer.from(raw, 'base64');
      if (b.length === 32) return b;
    }
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
    const utf8 = Buffer.from(raw, 'utf8');
    if (utf8.length === 32) return utf8;
  } catch {
    return null;
  }
  return null;
}

/** True when a server key is configured (secrets are encrypted at rest). */
export function hasServerKey(): boolean {
  return readKeyBytes() !== null;
}

/** Encrypt a secret for the `valueEncrypted` column. Falls back to legacy. */
export function encryptSecret(plaintext: string): string {
  const key = readKeyBytes();
  if (!key) return plaintext; // legacy: no key configured (dev only)
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/** Decrypt a `valueEncrypted` cell. Legacy plaintext passes through. */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored; // legacy plaintext row
  const key = readKeyBytes();
  if (!key) throw new Error('SECRET_KEY_MISSING: cannot decrypt secret without SECRET_ENCRYPTION_KEY');
  const parts = stored.slice(ENC_PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('SECRET_CORRUPT: malformed encrypted value');
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

/** True when the stored cell holds AES-256-GCM ciphertext (not plaintext). */
export function isEncryptedValue(stored: string): boolean {
  return stored.startsWith(ENC_PREFIX);
}

// ---------------------------------------------------------------------------
// 2. Masking: secret plaintext NEVER leaves the server via read APIs
// ---------------------------------------------------------------------------

/**
 * Mask a variable row for any read/create/update response.
 * - secrets: `valueEncrypted` removed, `value: null`, `hasValue: true`.
 * - plain vars: decrypted/plain value exposed as `value`, `valueEncrypted` removed.
 */
export function maskVariableRow<T extends { valueEncrypted: string; isSecret: boolean }>(row: T): Omit<T, 'valueEncrypted'> & { value: string | null; hasValue?: boolean } {
  const { valueEncrypted, ...rest } = row as T & { valueEncrypted: string };
  if (!row.isSecret) {
    return { ...rest, value: valueEncrypted } as Omit<T, 'valueEncrypted'> & { value: string | null };
  }
  return { ...rest, value: null, hasValue: true } as Omit<T, 'valueEncrypted'> & { value: string | null; hasValue?: boolean };
}

/** Replace every occurrence of each known secret with '***'. */
export function redactSecretsText(text: string, secrets: string[]): string {
  let out = text;
  const ordered = [...secrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  for (const secret of ordered) out = out.split(secret).join(REDACTED);
  return out;
}

// ---------------------------------------------------------------------------
// 3. SSRF-safe URL validation: allowlist http/https, block file:// + internals
// ---------------------------------------------------------------------------

export interface UrlCheck {
  ok: boolean;
  reason?: string;
}

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n < 0 || n > 255)) return false;
  if (o[0] === 10) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 127) return true;
  if (o[0] === 169 && o[1] === 254) return true; // cloud metadata
  if (o[0] === 0) return true;
  return false;
}

/** Validate a user-supplied URL before recorder/run (blocks SSRF/file://). */
export function checkAllowedHttpUrl(raw: string | undefined | null): UrlCheck {
  if (raw === undefined || raw === null || raw === '') return { ok: true };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'must be a valid absolute URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'only http(s) URLs are allowed (file://, javascript:, data: blocked)' };
  }
  if (u.username || u.password) return { ok: false, reason: 'credentials in URL are not allowed' };
  // Escape hatch for local E2E against the self-hosted /fixture target app:
  // ALLOW_PRIVATE_TARGETS=1 permits loopback/private hosts. NEVER enable on
  // internet-facing deployments (SSRF). Scheme + credential checks still apply.
  if (process.env.ALLOW_PRIVATE_TARGETS === '1') return { ok: true };
  let host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.includes(':')) {
    // Any IPv6 literal (loopback ::1, mapped ::ffff:127.0.0.1, link-local
    // fe80::/10, …) is blocked in P0 — self-host targets use IPv4/DNS.
    return { ok: false, reason: 'IPv6 literal targets are blocked (SSRF protection)' };
  }
  if (
    host === 'localhost' || host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost') ||
    host === 'metadata.google.internal' || host === '169.254.169.254' ||
    isPrivateIpv4(host) || host.startsWith('127.') || /^0x7f/i.test(host)
  ) {
    return { ok: false, reason: 'loopback/private-link-local targets are blocked (SSRF protection)' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 4. Test-definition validation: step allowlist => custom code disabled (P0)
// ---------------------------------------------------------------------------

/**
 * Every storable step type (P0 + P1 `callAction` + P1 wave-2 files/tabs/
 * dialogs/API). Anything else (incl. customCode) is rejected. `callAction`
 * is valid in TEST definitions; it is still rejected inside ACTION bodies
 * (nested calls would break total inlining) — see routes/actions.ts.
 *
 * Built from `P0_STEP_TYPES` + `P1_STEP_TYPES` in
 * packages/test-model/src/types.ts (mirrored here so this package keeps no
 * runtime dependency on test-model — keep the two lists in sync).
 */
const P0_STEP_TYPES: readonly string[] = [
  'goto', 'reload', 'goBack', 'goForward',
  'click', 'doubleClick', 'fill', 'clear', 'press', 'check', 'uncheck',
  'select', 'hover', 'waitForElement', 'waitForTimeout', 'waitForURL',
  'assertVisible', 'assertHidden', 'assertText', 'assertContainsText',
  'assertValue', 'assertURL', 'assertTitle', 'assertEnabled',
  'assertDisabled', 'assertChecked', 'screenshot',
];

/** P1 step types (mirrors `P1_STEP_TYPES` in packages/test-model/src/types.ts). */
const P1_STEP_TYPES: readonly string[] = [
  'callAction',
  'upload',
  'download',
  'newTab',
  'closeTab',
  'handleDialog',
  'apiRequest',
  'mockRoute',
];

/** P2 step types (mirrors `P2_STEP_TYPES` in packages/test-model/src/types.ts). */
const P2_STEP_TYPES: readonly string[] = ['visualCheck'];

export const SUPPORTED_STEP_TYPES: ReadonlySet<string> = new Set([
  ...P0_STEP_TYPES,
  ...P1_STEP_TYPES,
  ...P2_STEP_TYPES,
]);

/**
 * Plugin step types (`plugin:<name>`) are allowlisted by PATTERN (exact set is
 * registry-dependent). Unknown plugin steps still fail at compile/run time
 * with PLUGIN_NOT_FOUND — never silently skipped.
 */
export function isSupportedStepType(type: unknown): boolean {
  if (typeof type !== 'string') return false;
  if (SUPPORTED_STEP_TYPES.has(type)) return true;
  return type.startsWith('plugin:') && type.length > 'plugin:'.length;
}

export interface DefinitionIssue {
  code: string;
  message: string;
}

/**
 * Validate a stored TestDefinition before persist/compile.
 * Rejects unknown step types (custom code stays DISABLED in P0 for every role),
 * enforces the byte-size cap and fails closed on malformed input.
 */
export function validateDefinitionForStore(def: unknown): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    return [{ code: 'DEFINITION_NOT_OBJECT', message: 'definitionJson must be an object' }];
  }
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(def), 'utf8');
  } catch {
    return [{ code: 'DEFINITION_UNSERIALIZABLE', message: 'definitionJson must be JSON-serializable' }];
  }
  if (size > DEFINITION_JSON_MAX_BYTES) {
    issues.push({ code: 'DEFINITION_TOO_LARGE', message: `definitionJson is ${size} bytes (max ${DEFINITION_JSON_MAX_BYTES})` });
  }
  const steps = (def as { steps?: unknown }).steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    issues.push({ code: 'STEPS_EMPTY', message: 'definition.steps must be a non-empty array' });
    return issues;
  }
  const seen = new Set<string>();
  steps.forEach((s, i) => {
    const where = `steps[${i}]`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      issues.push({ code: 'STEP_NOT_OBJECT', message: `${where} must be an object` });
      return;
    }
    const rec = s as Record<string, unknown>;
    if (typeof rec['id'] !== 'string' || (rec['id'] as string).length === 0) {
      issues.push({ code: 'STEP_ID_MISSING', message: `${where}.id is required` });
    } else if (seen.has(rec['id'] as string)) {
      issues.push({ code: 'STEP_ID_DUPLICATE', message: `duplicate step id '${rec['id'] as string}'` });
    } else {
      seen.add(rec['id'] as string);
    }
    const type = rec['type'];
    if (typeof type !== 'string' || !isSupportedStepType(type)) {
      // P0: arbitrary custom code (customCode/eval/…) is disabled for ALL roles.
      issues.push({ code: 'STEP_TYPE_UNSUPPORTED', message: `${where}.type '${String(type)}' is not allowed (custom code is disabled in P0)` });
    }
    for (const k of ['code', 'script', 'eval', 'customCode']) {
      if (Object.prototype.hasOwnProperty.call(rec, k)) {
        issues.push({ code: 'STEP_FIELD_FORBIDDEN', message: `${where} field '${k}' is forbidden` });
      }
    }
    if (Object.getPrototypeOf(rec) !== Object.prototype && Object.getPrototypeOf(rec) !== null) {
      issues.push({ code: 'STEP_PROTOTYPE_UNEXPECTED', message: `${where} has an unexpected prototype` });
    }
  });
  return issues;
}

// ---------------------------------------------------------------------------
// 5. Filenames + server paths: never expose server filesystem to clients
// ---------------------------------------------------------------------------

/** Sanitise an id for use in Content-Disposition filenames (header injection). */
export function sanitizeExportFilename(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return clean.length > 0 ? `${clean}.spec.ts` : 'test.spec.ts';
}

/** Strip absolute server paths (cwd/tmpdir/storage) from client-facing text. */
export function stripServerPaths(text: string, extraRoots: string[] = []): string {
  let out = text;
  const roots = [process.cwd(), ...extraRoots].filter(Boolean);
  for (const root of roots) {
    if (root && out.includes(root)) out = out.split(root).join('[server]');
  }
  // Residual unix/windows absolute path shapes that may come from tool stacks.
  out = out.replace(/\/tmp\/pw-studio-runs\/[^\s'"]*/g, '[workdir]');
  out = out.replace(/[A-Za-z]:\\[^\s'"]* (?:\\[^\s'"]*)*/g, (m) => (m.includes('node_modules') ? m : '[server-path]'));
  return out;
}

// ---------------------------------------------------------------------------
// 6. Roles: custom code stays disabled in P0, helper ready for P1 RBAC
// ---------------------------------------------------------------------------

/** Roles allowed to author custom code IF it is ever enabled (P1). P0: nobody. */
export function isCustomCodeEnabled(): boolean {
  return process.env.ALLOW_CUSTOM_CODE === '1';
}

export function mayUseCustomCode(role: string | undefined): boolean {
  if (!isCustomCodeEnabled()) return false;
  return role === 'admin' || role === 'developer';
}
