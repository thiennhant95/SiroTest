/**
 * P0 Security tests — Day 8-10 audit (11-security/security.md).
 * Run: `npx tsx --test src/security.test.ts` (no DB needed; pure helpers only).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_MAX_BYTES,
  DEFINITION_JSON_MAX_BYTES,
  JSON_BODY_LIMIT_BYTES,
  checkAllowedHttpUrl,
  decryptSecret,
  encryptSecret,
  hasServerKey,
  isEncryptedValue,
  maskVariableRow,
  redactSecretsText,
  sanitizeExportFilename,
  stripServerPaths,
  validateDefinitionForStore,
} from './security.js';
import { authenticateWsToken, resolveUser } from './auth.js';

const KEY_B64 = Buffer.alloc(32, 7).toString('base64');
let savedKey: string | undefined;
let savedServerKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.SECRET_ENCRYPTION_KEY;
  savedServerKey = process.env.SERVER_SECRET_KEY;
  delete process.env.SECRET_ENCRYPTION_KEY;
  delete process.env.SERVER_SECRET_KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.SECRET_ENCRYPTION_KEY;
  else process.env.SECRET_ENCRYPTION_KEY = savedKey;
  if (savedServerKey === undefined) delete process.env.SERVER_SECRET_KEY;
  else process.env.SERVER_SECRET_KEY = savedServerKey;
});

describe('secret at rest (AES-256-GCM)', () => {
  it('encrypts with key configured; ciphertext differs per call (random IV)', () => {
    process.env.SECRET_ENCRYPTION_KEY = KEY_B64;
    assert.equal(hasServerKey(), true);
    const a = encryptSecret('s3cr3t-pw');
    const b = encryptSecret('s3cr3t-pw');
    assert.ok(isEncryptedValue(a));
    assert.notEqual(a, b);
    assert.ok(!a.includes('s3cr3t-pw'));
    assert.equal(decryptSecret(a), 's3cr3t-pw');
    assert.equal(decryptSecret(b), 's3cr3t-pw');
  });

  it('falls back to legacy plaintext only when no key is configured', () => {
    assert.equal(hasServerKey(), false);
    const stored = encryptSecret('s3cr3t-pw');
    assert.equal(isEncryptedValue(stored), false);
    assert.equal(decryptSecret(stored), 's3cr3t-pw'); // legacy passthrough
  });

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    process.env.SECRET_ENCRYPTION_KEY = KEY_B64;
    const enc = encryptSecret('s3cr3t-pw');
    const tampered = enc.slice(0, -2) + (enc.endsWith('AA') ? 'BB' : 'AA');
    assert.throws(() => decryptSecret(tampered));
  });
});

describe('read APIs never return secret plaintext', () => {
  it('masks secret rows (value=null, hasValue, no valueEncrypted)', () => {
    const masked = maskVariableRow({
      id: 'v1', key: 'PW', valueEncrypted: 'enc:v1:xxx', isSecret: true,
    });
    assert.equal((masked as { value: unknown }).value, null);
    assert.equal((masked as { hasValue: unknown }).hasValue, true);
    assert.ok(!('valueEncrypted' in masked));
    assert.ok(!JSON.stringify(masked).includes('enc:v1:xxx'));
  });

  it('plain vars expose value but never the storage column name', () => {
    const masked = maskVariableRow({ id: 'v2', key: 'URL', valueEncrypted: 'https://x', isSecret: false });
    assert.equal((masked as { value: unknown }).value, 'https://x');
    assert.ok(!('valueEncrypted' in masked));
  });
});

describe('URL validation (SSRF guard)', () => {
  it('allows public http(s)', () => {
    assert.equal(checkAllowedHttpUrl('https://example.com/login').ok, true);
    assert.equal(checkAllowedHttpUrl('http://app.example.com:8080/').ok, true);
    assert.equal(checkAllowedHttpUrl(undefined).ok, true);
  });
  it('blocks file://, javascript:, data:, ftp:', () => {
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'ftp://host/x', 'not-a-url']) {
      assert.equal(checkAllowedHttpUrl(u).ok, false, u);
    }
  });
  it('blocks loopback / private / metadata targets', () => {
    for (const u of [
      'http://localhost:3000/', 'http://127.0.0.1/', 'http://10.0.0.5/',
      'http://172.16.9.9/', 'http://192.168.1.1/', 'http://169.254.169.254/',
      'http://[::1]/', 'http://user:pass@example.com/',
    ]) {
      assert.equal(checkAllowedHttpUrl(u).ok, false, u);
    }
  });
  it('ALLOW_PRIVATE_TARGETS=1 permits loopback for local fixture E2E only', () => {
    process.env.ALLOW_PRIVATE_TARGETS = '1';
    try {
      assert.equal(checkAllowedHttpUrl('http://localhost:3001/fixture/login').ok, true);
      // Scheme guard still applies even with the hatch open.
      assert.equal(checkAllowedHttpUrl('file:///etc/passwd').ok, false);
    } finally {
      delete process.env.ALLOW_PRIVATE_TARGETS;
    }
  });
});

describe('definition validation (custom code disabled)', () => {
  const good = {
    schemaVersion: '1.0', id: 't1', projectId: 'p1', name: 'T', browser: 'chromium',
    steps: [{ id: 's1', type: 'goto', url: 'https://example.com' }],
  };
  it('accepts allowlisted steps', () => {
    assert.deepEqual(validateDefinitionForStore(good), []);
  });
  it('rejects customCode/unknown step types and forbidden fields', () => {
    const bad = {
      ...good,
      steps: [
        { id: 's1', type: 'customCode', code: 'require("fs")' },
        { id: 's2', type: 'dragAndDrop' },
        { id: 's3', type: 'click', script: 'evil' },
      ],
    };
    const issues = validateDefinitionForStore(bad);
    assert.ok(issues.some((i) => i.code === 'STEP_TYPE_UNSUPPORTED'));
    assert.ok(issues.some((i) => i.code === 'STEP_FIELD_FORBIDDEN'));
  });
  it('rejects oversized definitions (upload limit)', () => {
    const big = { ...good, steps: [{ id: 's1', type: 'goto', url: 'https://example.com', pad: 'x'.repeat(DEFINITION_JSON_MAX_BYTES) }] };
    assert.ok(validateDefinitionForStore(big).some((i) => i.code === 'DEFINITION_TOO_LARGE'));
  });
  it('fails closed on malformed input', () => {
    assert.ok(validateDefinitionForStore(null).length > 0);
    assert.ok(validateDefinitionForStore({ steps: [] }).some((i) => i.code === 'STEPS_EMPTY'));
  });
});

describe('redaction + filenames + server paths + limits', () => {
  it('redacts every secret occurrence from text', () => {
    assert.equal(redactSecretsText('login s3cr3t-pw with s3cr3t-pw', ['s3cr3t-pw']), 'login *** with ***');
  });
  it('sanitises export filenames (header injection)', () => {
    assert.equal(sanitizeExportFilename('abc123'), 'abc123.spec.ts');
    assert.equal(sanitizeExportFilename('a"; filename="evil'), 'afilenameevil.spec.ts');
    assert.ok(!sanitizeExportFilename('../../etc/passwd').includes('/'));
  });
  it('strips absolute server paths from client-facing text', () => {
    const out = stripServerPaths(`failed at ${process.cwd()}/dist/x.js`);
    assert.ok(!out.includes(process.cwd()));
  });
  it('size-limit constants are sane', () => {
    assert.equal(JSON_BODY_LIMIT_BYTES, 1024 * 1024);
    assert.ok(DEFINITION_JSON_MAX_BYTES <= JSON_BODY_LIMIT_BYTES / 2);
    assert.ok(ARTIFACT_MAX_BYTES > 0);
  });
});

describe('auth API/WS contract', () => {
  it('resolves Bearer and x-user-id credentials; rejects missing', () => {
    assert.ok(resolveUser('Bearer alice', undefined));
    assert.ok(resolveUser(undefined, 'bob'));
    assert.equal(resolveUser(undefined, undefined), null);
  });
  it('WS handshake requires ?token= (closes the anonymous-event leak)', () => {
    assert.equal(authenticateWsToken({}), null);
    assert.equal(authenticateWsToken({ runId: 'r1' }), null);
    const u = authenticateWsToken({ token: 'alice', runId: 'r1' });
    assert.equal(u?.id, 'alice');
  });
});
