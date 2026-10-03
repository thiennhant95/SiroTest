import type { FastifyRequest, FastifyReply } from 'fastify';
import { ApiError } from './errors.js';
import { db } from './db.js';

/**
 * P0 auth: Bearer token or x-user-id header resolves a user.
 * Real implementation verifies JWT/session via users table; here the
 * contract (401/403 + membership check hook) is what matters.
 *
 * Security (11-security/security.md):
 * - Every REST route uses requireAuth. WS /ws requires ?token=<same credential>.
 * - No cookie auth is used, so there is no cookie-CSRF surface: state-changing
 *   requests must carry an explicit Authorization/x-user-id header or WS token
 *   that a cross-site form/WS handshake cannot mint (see SELFHOST notes in
 *   11-security/security.md). If cookie sessions are introduced later, add
 *   Origin-checked CSRF tokens before enabling them.
 */
export interface AuthUser {
  id: string;
  role: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/**
 * Dev-stub user auto-provisioning (pilot unblocker).
 *
 * P0 auth mints identities from a header without a signup flow, so a fresh
 * tester has no User row — and without it no owner membership can exist,
 * which makes every project-scoped write 403 for exactly the users the
 * pilot is for. Auto-provision a minimal row on first sight (idempotent
 * upsert; never overwrites an existing row). Real auth (JWT/OIDC) replaces
 * the stub and keeps this as a harmless no-op. Failures never fail the
 * request — downstream membership checks apply as before.
 */
export async function ensureUserRow(userId: string): Promise<void> {
  try {
    // Read first: the common case (returning user) stays read-only, and we
    // never issue an empty-update upsert (whose edge behavior varies).
    // Lost creates race safely into P2002, which is swallowed below.
    const existing = await db().user.findUnique({ where: { id: userId } });
    if (existing) return;
    await db().user.create({
      data: { id: userId, email: `${userId}@stub.local`, authRef: 'stub', role: 'tester' },
    });
  } catch {
    // DB hiccup or lost create race: proceed — membership checks still
    // enforce as before.
  }
}

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  // 1) Stateful session token (real auth): Bearer <session-token>.
  // Session tokens are 43-char base64url (32 random bytes). Anything shaped
  // like one MUST verify — a revoked/unknown token is rejected outright and
  // never demoted to a dev identity (otherwise logout would be meaningless).
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const bearer = header.slice(7).trim();
    if (/^[A-Za-z0-9_-]{32,64}$/.test(bearer)) {
      const verified = await verifySessionToken(bearer).catch(() => null);
      if (verified) {
        req.user = verified;
        return;
      }
      throw new ApiError('UNAUTHORIZED', 'Invalid or expired token', 401);
    }
    // Not a session token: legacy dev clients send `Bearer <user-id>`.
    // Honor that only while dev auth is allowed (otherwise 401 outright —
    // a Bearer-looking credential is never silently demoted on hard hosts).
    if (!devAuthAllowed()) {
      throw new ApiError('UNAUTHORIZED', 'Invalid or expired token', 401);
    }
    const legacy = resolveUser(header, undefined);
    if (!legacy) throw new ApiError('UNAUTHORIZED', 'Missing credentials', 401);
    req.user = legacy;
    await ensureUserRow(legacy.id);
    return;
  }
  // 2) Dev stub (x-user-id header). Disabled on hardened hosts.
  const user = resolveUser(undefined, req.headers['x-user-id'] as string | undefined);
  if (!user) {
    throw new ApiError('UNAUTHORIZED', 'Missing credentials', 401);
  }
  if (!devAuthAllowed()) {
    throw new ApiError('UNAUTHORIZED', 'Dev auth is disabled on this host: log in for a session token', 401);
  }
  req.user = user;
  // Provision the stub identity so first-touch flows (project creation ->
  // owner membership -> scoped writes) work for fresh testers. No-op once
  // real auth backs identities; never fails the request.
  await ensureUserRow(user.id);
}

/**
 * Resolve a user from a Bearer token or dev x-user-id header without a request.
 * Shared by REST (requireAuth) and WS (?token=) authentication so both enforce
 * the same credential contract.
 */
export function resolveUser(authorization: string | undefined, userIdHeader: string | undefined): AuthUser | null {
  const userId =
    (authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : undefined) ||
    userIdHeader;
  if (!userId) return null;
  // TODO: look up users table + verify session/token hash.
  return { id: userId, role: 'tester' };
}

/** Dev stub allowed? Hosts set ALLOW_DEV_AUTH=0 to force real session tokens. */
export function devAuthAllowed(): boolean {
  return process.env.ALLOW_DEV_AUTH !== '0';
}

/**
 * Verify a stateful session token (login/register issued). Returns the user
 * with the DB role, or null. Touches lastUsedAt (sliding activity, best
 * effort — a failure there must not fail the request).
 */
export async function verifySessionToken(raw: string): Promise<AuthUser | null> {
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(raw.trim(), 'utf8').digest('hex');
  const row = await db().authToken.findUnique({
    where: { tokenHash: digest },
    include: { user: true },
  });
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await db().authToken.delete({ where: { id: row.id } }).catch(() => undefined);
    return null;
  }
  void db().authToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return { id: row.user.id, role: row.user.role };
}

/** WS handshake auth: ?token=<bearer-or-user-id>. Returns null when rejected. */
export function authenticateWsToken(query: unknown): AuthUser | null {
  const q = (query ?? {}) as Record<string, unknown>;
  const token = typeof q['token'] === 'string' ? (q['token'] as string) : undefined;
  if (!token) return null;
  return resolveUser(token.startsWith('Bearer ') ? token : `Bearer ${token}`, undefined);
}

/** Async WS handshake: accepts stateful session tokens, falls back to stub. */
export async function authenticateWsTokenAsync(query: unknown): Promise<AuthUser | null> {
  const q = (query ?? {}) as Record<string, unknown>;
  const raw = typeof q['token'] === 'string' ? q['token'].trim() : '';
  if (!raw) return null;
  const bearer = raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw;
  // A 43-char base64url token is a session token; anything else is a dev id.
  // Token-shaped misses MUST NOT fall back (see requireAuth): logout and
  // revocation depend on it.
  if (/^[A-Za-z0-9_-]{32,64}$/.test(bearer)) {
    const verified = await verifySessionToken(bearer).catch(() => null);
    if (verified) return verified;
    return null;
  }
  if (!devAuthAllowed()) return null;
  return resolveUser(`Bearer ${bearer}`, undefined);
}

/** P1-ready: only Developer/Admin may author custom code (P0: disabled for all). */
export function requirePrivileged(req: FastifyRequest): AuthUser {
  const user = req.user;
  if (!user) throw new ApiError('UNAUTHORIZED', 'Missing credentials', 401);
  if (user.role !== 'admin' && user.role !== 'developer') {
    throw new ApiError('FORBIDDEN', 'Custom code requires Developer/Admin role', 403);
  }
  return user;
}

/**
 * Project access (api-spec.md + 11-security/security.md): every write that
 * touches a project must prove membership. The project is resolved from
 * `params.projectId`, or from the owning project of a test/run id in
 * `params.id`. Admins bypass; everyone else needs a project_members row
 * (owners are added automatically at project creation). Routes without a
 * project context (e.g. GET /projects) only require authentication.
 */
export async function requireProjectAccess(req: FastifyRequest): Promise<AuthUser> {
  if (!req.user) throw new ApiError('UNAUTHORIZED', 'Missing credentials', 401);
  await ensureUserRow(req.user.id);
  const params = (req.params ?? {}) as Record<string, unknown>;
  let projectId: string | undefined;
  if (typeof params['projectId'] === 'string' && params['projectId'].length > 0) {
    projectId = params['projectId'] as string;
  } else if (typeof params['id'] === 'string' && (params['id'] as string).length > 0) {
    const id = params['id'] as string;
    const test = await db().test.findUnique({ where: { id }, select: { projectId: true } });
    if (test) {
      projectId = test.projectId;
    } else {
      const run = await db().run.findUnique({ where: { id }, select: { projectId: true } });
      if (run) {
        projectId = run.projectId;
      } else {
        const project = await db().project.findUnique({ where: { id }, select: { id: true } });
        if (project) projectId = project.id;
      }
    }
  }
  if (!projectId) return req.user;
  const userRow = await db().user.findUnique({ where: { id: req.user.id } });
  if (userRow?.role === 'admin') return req.user;
  const member = await db().projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: req.user.id } },
  });
  if (!member) throw new ApiError('FORBIDDEN', `No access to project ${projectId}`, 403);
  return req.user;
}
