/**
 * P2 — audit log: `writeAudit()` helper + read API.
 *
 * REGISTRATION CONTRACT (app.ts is frozen by task scope — maintainer wires):
 *   import { auditRoutes } from './routes/audit.js';
 *   await app.register(auditRoutes);   // paths are absolute (/api/v1/…), register at ROOT, no prefix
 *
 * - Mutating P2 routes call `writeAudit()` (fire-and-forget, never fails the
 *   main operation). Older P0/P1 routes are untouched; they can adopt
 *   `writeAudit()` later without any change here.
 * - `details` are JSON-serialized with sensitive keys masked (password /
 *   secret / token / … → '***'); secret VALUES are never passed in.
 * - Read: GET /projects/:projectId/audit (viewer+), filters + limit/offset.
 * - OIDC status: GET /auth/oidc/status (auth only, never exposes the secret).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { parseOrThrow } from '../schemas.js';
import { db } from '../db.js';
import { readOidcConfig } from '../rbac.js';
import { requireRole } from '../rbac.js';

const auditQuery = z.object({
  action: z.string().min(1).max(120).optional(),
  userId: z.string().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100000).optional(),
});

const SENSITIVE_KEY = /(password|passwd|secret|token|api[_-]?key|auth|credential|private[_-]?key|session)/i;
export const AUDIT_REDACTED = '***';

/** JSON-safe deep mask of sensitive keys (never throws — falls back to a string). */
export function redactAuditDetails(details: unknown): string | null {
  if (details === undefined || details === null) return null;
  try {
    const masked = maskKeys(details);
    const json = JSON.stringify(masked);
    return json.length > 8000 ? `${json.slice(0, 8000)}…[truncated]` : json;
  } catch {
    return String(details).slice(0, 500);
  }
}

function maskKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? AUDIT_REDACTED : maskKeys(v);
    }
    return out;
  }
  return value;
}

export interface AuditWrite {
  projectId?: string | null;
  userId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  details?: unknown;
}

/**
 * Best-effort audit write: resolves to void and NEVER rejects (audit must
 * not fail the operation it records). Call WITHOUT await or with
 * `void writeAudit(…)` — it is already fire-and-forget safe.
 */
export async function writeAudit(entry: AuditWrite): Promise<void> {
  try {
    await db().auditLog.create({
      data: {
        ...(entry.projectId ? { projectId: entry.projectId } : {}),
        ...(entry.userId ? { userId: entry.userId } : {}),
        action: entry.action,
        ...(entry.entityType ? { entityType: entry.entityType } : {}),
        ...(entry.entityId ? { entityId: entry.entityId } : {}),
        ...(redactAuditDetails(entry.details) !== null
          ? { details: redactAuditDetails(entry.details) as string }
          : {}),
      },
    });
  } catch {
    // Audit is evidence, not control flow — swallow (server log untouched to
    // avoid pulling a logger dependency into this module).
  }
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  // GET /projects/:projectId/audit?action=&userId=&limit=&offset=
  app.get('/api/v1/projects/:projectId/audit', { preHandler: requireAuth }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    await requireRole(req, projectId, 'viewer');
    const q = parseOrThrow(auditQuery, req.query);
    const rows = await db().auditLog.findMany({
      where: {
        projectId,
        ...(q.action ? { action: q.action } : {}),
        ...(q.userId ? { userId: q.userId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit ?? 50,
      skip: q.offset ?? 0,
    });
    return rows;
  });

  // GET /auth/oidc/status — safe-to-expose config surface (no secret, ever).
  app.get('/api/v1/auth/oidc/status', { preHandler: requireAuth }, async () => {
    const cfg = readOidcConfig();
    return {
      enabled: cfg.enabled,
      issuer: cfg.enabled ? cfg.issuer : null,
      clientIdConfigured: cfg.clientId.length > 0,
      clientSecretConfigured: cfg.clientSecretConfigured,
      redirectUri: cfg.enabled ? cfg.redirectUri : null,
      scopes: cfg.scopes,
      verifiedAgainstLiveIdp: false,
      note: 'OIDC is configuration-only in this build; Bearer auth remains primary. See docs/oidc-sso.md.',
    };
  });
}
