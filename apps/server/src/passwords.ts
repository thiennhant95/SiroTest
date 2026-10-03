/**
 * Password + token primitives (real auth; no external deps).
 *
 * - Passwords: scrypt (N=16384, r=8, p=1, 32-byte key), random 16-byte salt
 *   per password, timing-safe compare. Format:
 *   `scrypt$v1$<salt-b64>$<hash-b64>`.
 * - Tokens: 32 random bytes (base64url, shown ONCE at login); only the
 *   SHA-256 hex digest is stored (`AuthToken.tokenHash`). TTL 30 days
 *   (AUTH_TOKEN_DAYS), sliding via `lastUsedAt`.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

function scryptKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    (scryptCb as (...args: unknown[]) => void)(
      password,
      salt,
      KEY_LEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (err: unknown, key?: unknown) => {
        if (err || !(key instanceof Buffer)) reject(err ?? new Error('scrypt failed'));
        else resolve(key);
      },
    );
  });
}

const PREFIX = 'scrypt$v1$';
const KEY_LEN = 32;
const SALT_LEN = 16;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export function tokenTtlDays(): number {
  const raw = Number(process.env.AUTH_TOKEN_DAYS ?? '30');
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 30;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scryptKey(password, salt);
  return `${PREFIX}${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    if (!stored.startsWith(PREFIX)) return false;
    // Format: `scrypt$v1$<salt-b64>$<hash-b64>` → 4 $-separated parts.
    const parts = stored.split('$');
    if (parts.length !== 4) return false;
    const saltB64 = parts[2] as string;
    const hashB64 = parts[3] as string;
    if (!saltB64 || !hashB64) return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    if (salt.length !== SALT_LEN || expected.length !== KEY_LEN) return false;
    const actual = await scryptKey(password, salt);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** A raw bearer token (transport) — store only its digest. */
export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + tokenTtlDays() * 24 * 60 * 60 * 1000);
}
