import type { FastifyRequest, FastifyReply } from 'fastify';
import { ApiError } from './errors.js';

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

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const user = resolveUser(req.headers.authorization, req.headers['x-user-id'] as string | undefined);
  if (!user) {
    throw new ApiError('UNAUTHORIZED', 'Missing credentials', 401);
  }
  req.user = user;
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

/** WS handshake auth: ?token=<bearer-or-user-id>. Returns null when rejected. */
export function authenticateWsToken(query: unknown): AuthUser | null {
  const q = (query ?? {}) as Record<string, unknown>;
  const token = typeof q['token'] === 'string' ? (q['token'] as string) : undefined;
  if (!token) return null;
  return resolveUser(token.startsWith('Bearer ') ? token : `Bearer ${token}`, undefined);
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

/** P0: any authenticated user may operate; project role check plugs in here. */
export async function requireProjectAccess(req: FastifyRequest): Promise<AuthUser> {
  if (!req.user) throw new ApiError('UNAUTHORIZED', 'Missing credentials', 401);
  // TODO: check project_members for req.params projectId.
  return req.user;
}
