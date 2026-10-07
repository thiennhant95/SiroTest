/**
 * P2 — granular RBAC + OIDC SSO configuration helpers.
 *
 * SCOPE (honest):
 * - RBAC here is ENFORCED for the P2 routes created in this wave
 *   (workers / analytics / audit) via `requireRole(projectId, minRole)`.
 * - `requireProjectWrite` / `requireWriteAccessToProject` extend the same
 *   viewer-block to all P0/P1 mutating routes (a project viewer or
 *   non-member gets an explicit 403 on writes; reads are unchanged).
 *   Verified by tests/integration/rbac.test.ts.
 * - OIDC SSO is CONFIG + discovery/exchange helpers + docs
 *   (`docs/oidc-sso.md`). It is DISABLED by default, the Bearer /
 *   `x-user-id` credential stays the primary auth, and NO live IdP
 *   verification has been performed (needs a real IdP — see docs).
 */

import type { FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';
import { db } from './db.js';
import { ensureUserRow } from './auth.js';

export type ProjectRole = 'viewer' | 'editor' | 'owner';

const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

function asProjectRole(raw: unknown): ProjectRole | null {
  return raw === 'owner' || raw === 'editor' || raw === 'viewer' ? raw : null;
}

/**
 * Global role of a user id. Falls back to 'tester' when the user row does
 * not exist (dev stub auth mints ids without rows — same leniency as the
 * project-creation owner bootstrap in routes/projects.ts).
 */
export async function getGlobalRole(userId: string): Promise<string> {
  const row = await db().user.findUnique({ where: { id: userId }, select: { role: true } });
  return row?.role ?? 'tester';
}

/**
 * Effective project role: global `admin` bypasses everything (owner
 * equivalent); otherwise the project_members row decides. Null = no access.
 */
export async function resolveProjectRole(userId: string, projectId: string): Promise<ProjectRole | null> {
  const global = await getGlobalRole(userId);
  if (global === 'admin') return 'owner';
  const member = await db().projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true },
  });
  if (!member) return null;
  return asProjectRole(member.role) ?? 'viewer';
}

/**
 * Project-scoped RBAC gate for NEW (P2) routes. `viewer` may read;
 * `editor`+ may write; `owner` for destructive/admin project actions.
 * Throws 401/403 ApiError (existing error codes only).
 */
export async function requireRole(
  req: FastifyRequest,
  projectId: string,
  minRole: ProjectRole,
): Promise<ProjectRole> {
  if (!req.user) throw new ApiError('UNAUTHORIZED', 'Missing credentials', 401);
  const role = await resolveProjectRole(req.user.id, projectId);
  if (!role) throw new ApiError('FORBIDDEN', `No access to project ${projectId}`, 403);
  if (PROJECT_ROLE_RANK[role] < PROJECT_ROLE_RANK[minRole]) {
    throw new ApiError('FORBIDDEN', `Requires project role '${minRole}' or higher (have '${role}')`, 403);
  }
  return role;
}

/**
 * Membership-only read gate for an explicitly resolved project id
 * (per-id routes that already loaded their row: files, profiles,
 * schedules, healing proposals, ...). Same contract as auth.ts
 * requireProjectAccess minus the param resolution.
 */
export async function requireReadAccessToProject(req: FastifyRequest, projectId: string): Promise<void> {
  if (!req.user) throw new ApiError('UNAUTHORIZED', 'Missing credentials', 401);
  await ensureUserRow(req.user.id);
  const userRow = await db().user.findUnique({ where: { id: req.user.id } });
  if (userRow?.role === 'admin') return;
  const member = await db().projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: req.user.id } },
  });
  if (!member) throw new ApiError('FORBIDDEN', `No access to project ${projectId}`, 403);
}

/**
 * Write gate for an explicitly resolved project id: membership PLUS
 * project role `editor`+. Global `admin` bypasses; global `viewer` is
 * read-only everywhere (even with a member row). Viewers get an explicit
 * 403 — never a silent no-op, never a write.
 */
export async function requireWriteAccessToProject(req: FastifyRequest, projectId: string): Promise<ProjectRole> {
  if (!req.user) throw new ApiError('UNAUTHORIZED', 'Missing credentials', 401);
  await ensureUserRow(req.user.id);
  const global = await getGlobalRole(req.user.id);
  if (global === 'admin') return 'owner';
  if (global === 'viewer') {
    throw new ApiError('FORBIDDEN', 'Global role viewer is read-only', 403);
  }
  const member = await db().projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: req.user.id } },
  });
  if (!member) throw new ApiError('FORBIDDEN', `No access to project ${projectId}`, 403);
  const role = asProjectRole(member.role) ?? 'viewer';
  if (PROJECT_ROLE_RANK[role] < PROJECT_ROLE_RANK.editor) {
    throw new ApiError('FORBIDDEN', `Requires project role 'editor' or higher (have '${role}')`, 403);
  }
  return role;
}

/**
 * Write gate with the same param resolution as auth.ts requireProjectAccess
 * (`params.projectId`, or the owning project of a test/run id in
 * `params.id`). Use on every mutating P0/P1 route so project viewers (and
 * non-members) cannot write through the pre-P2 endpoints.
 */
export async function requireProjectWrite(req: FastifyRequest): Promise<ProjectRole> {
  if (!req.user) throw new ApiError('UNAUTHORIZED', 'Missing credentials', 401);
  const params = (req.params ?? {}) as Record<string, unknown>;
  let projectId: string | undefined;
  if (typeof params['projectId'] === 'string') {
    // Empty `:projectId` (e.g. `POST /projects//environments`) must fail
    // explicitly — without this the route would try a create with
    // `projectId: ''` and die on the FK with a 500.
    if (params['projectId'].length === 0) {
      throw new ApiError('VALIDATION_ERROR', 'projectId must not be empty', 400);
    }
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
  // Unresolvable id (unknown test/run/project): let the route's own lookup
  // answer 404 (mirrors requireProjectAccess) instead of leaking 403 here.
  if (!projectId) return 'editor';
  return requireWriteAccessToProject(req, projectId);
}

/**
 * Refuse destructive deletes while runs are live: deleting a test/suite/
 * environment out from under a queued/running worker wipes its rows
 * (cascade) and crashes the worker with an unhandled store error. Cancel
 * the runs first — explicit, never silent.
 */
export async function assertNoActiveRuns(filter: { testId?: string; suiteId?: string; environmentId?: string }, what: string): Promise<void> {
  const active = await db().run.findFirst({
    where: { ...filter, status: { in: ['queued', 'running'] } },
    select: { id: true },
  });
  if (active) {
    throw new ApiError(
      'CONFLICT_ACTIVE_RUNS',
      `${what} has active (queued/running) runs — cancel them first`,
      409,
    );
  }
}

/**
 * Global-role gate for non-project writes (worker register/deregister,
 * stale sweep). `viewer` is read-only everywhere in P2.
 */
export async function requireGlobalRole(req: FastifyRequest, allowed: string[]): Promise<string> {
  if (!req.user) throw new ApiError('UNAUTHORIZED', 'Missing credentials', 401);
  const role = await getGlobalRole(req.user.id);
  if (!allowed.includes(role)) {
    throw new ApiError('FORBIDDEN', `Requires global role one of [${allowed.join(', ')}] (have '${role}')`, 403);
  }
  return role;
}

/** Global writers: everyone except viewer (viewer is read-only in P2). */
export async function requireGlobalWriter(req: FastifyRequest): Promise<string> {
  return requireGlobalRole(req, ['admin', 'developer', 'tester']);
}

// ---------------------------------------------------------------------------
// OIDC SSO — configuration shape + protocol helpers (NOT live-verified).
//
// Disabled by default. When enabled, this module only builds the login URL
// and performs discovery + code exchange against a REAL IdP (operator
// supplied). Signature verification MUST use the IdP JWKS before minting a
// session — `decodeJwtPayloadUnsafe` below is explicitly unsafe and exists
// only so tests/docs can show the claims shape without network access.
// ---------------------------------------------------------------------------

export interface OidcConfig {
  enabled: boolean;
  issuer: string;
  clientId: string;
  /** True when OIDC_CLIENT_SECRET is set (value never leaves the server). */
  clientSecretConfigured: boolean;
  redirectUri: string;
  scopes: string[];
}

export function readOidcConfig(env: NodeJS.ProcessEnv = process.env): OidcConfig {
  const enabled = env['OIDC_ENABLED'] === '1';
  return {
    enabled,
    issuer: env['OIDC_ISSUER'] ?? '',
    clientId: env['OIDC_CLIENT_ID'] ?? '',
    clientSecretConfigured: (env['OIDC_CLIENT_SECRET'] ?? '').length > 0,
    redirectUri: env['OIDC_REDIRECT_URI'] ?? '',
    scopes: (env['OIDC_SCOPES'] ?? 'openid email profile').split(/\s+/).filter(Boolean),
  };
}

/** Pure validation of the OIDC config shape (no network). Returns error strings. */
export function validateOidcConfig(cfg: Pick<OidcConfig, 'issuer' | 'clientId' | 'redirectUri'>): string[] {
  const errors: string[] = [];
  if (!cfg.issuer || !/^https:\/\/.+/.test(cfg.issuer)) {
    errors.push('OIDC_ISSUER must be an https:// issuer URL (no network call made)');
  }
  if (!cfg.clientId) errors.push('OIDC_CLIENT_ID is required');
  if (!cfg.redirectUri || !/^https?:\/\/.+/.test(cfg.redirectUri)) {
    errors.push('OIDC_REDIRECT_URI must be an absolute http(s) URL registered at the IdP');
  }
  return errors;
}

export function oidcClientSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env['OIDC_CLIENT_SECRET'] ?? '';
}

/**
 * Build the IdP login URL (authorization endpoint comes from discovery —
 * passed in so this stays pure/testable without network).
 */
export function buildOidcLoginUrl(
  cfg: Pick<OidcConfig, 'clientId' | 'redirectUri' | 'scopes'>,
  authorizationEndpoint: string,
  state: string,
  nonce: string,
): string {
  const u = new URL(authorizationEndpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('scope', cfg.scopes.join(' '));
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  return u.toString();
}

export interface OidcDiscoveryDocument {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
  issuer: string;
}

/** OIDC discovery (network — needs a real IdP; NOT covered by offline tests). */
export async function discoverOidcIssuer(issuer: string): Promise<OidcDiscoveryDocument> {
  const wellKnown = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(wellKnown);
  if (!res.ok) throw new Error(`OIDC discovery failed for ${issuer}: HTTP ${res.status}`);
  const doc = (await res.json()) as OidcDiscoveryDocument;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error('OIDC discovery document is missing authorization/token/jwks endpoints');
  }
  return doc;
}

export interface OidcTokenSet {
  id_token: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

/** Authorization-code exchange (network — needs a real IdP; NOT live-verified). */
export async function exchangeOidcCode(
  tokenEndpoint: string,
  opts: { code: string; clientId: string; clientSecret: string; redirectUri: string },
): Promise<OidcTokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
  });
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`OIDC code exchange failed: HTTP ${res.status}`);
  const json = (await res.json()) as OidcTokenSet;
  if (!json.id_token) throw new Error('OIDC code exchange returned no id_token');
  return json;
}

/**
 * UNSAFE base64url payload decode — for shape inspection/docs only.
 * NEVER trust its output: verify the JWT signature against the IdP JWKS
 * (jwks_uri from discovery) before minting any session. No JWT dependency
 * is added in this wave, so live verification is operator-side (see docs).
 */
export function decodeJwtPayloadUnsafe(idToken: string): Record<string, unknown> {
  const parts = idToken.split('.');
  if (parts.length < 2 || !parts[1]) throw new Error('malformed JWT (expected header.payload.signature)');
  const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json) as Record<string, unknown>;
}
