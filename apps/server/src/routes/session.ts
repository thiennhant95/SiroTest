import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import { ApiError } from '../errors.js';
import { hashPassword, hashToken, mintToken, tokenExpiry, verifyPassword } from '../passwords.js';
import { parseOrThrow } from '../schemas.js';

/**
 * P2 — real session auth (email + password, stateful bearer tokens).
 *
 * - POST /auth/register {email, name?, password} → creates a tester user and
 *   returns a one-time token (201). Duplicate email → 409 USER_EXISTS.
 * - POST /auth/login {email, password} → verifies (401 INVALID_CREDENTIALS
 *   for unknown email AND wrong password — no enumeration) and returns a
 *   one-time token. Raw tokens never touch logs or the DB (SHA-256 only).
 * - POST /auth/logout → revokes the calling token (Bearer only; x-user-id
 *   dev credentials have nothing to revoke → 200 noop).
 * - GET /auth/me → the calling identity (role included).
 *
 * The legacy `x-user-id` dev header keeps working unless the host sets
 * `ALLOW_DEV_AUTH=0` (self-host hardening); Bearer tokens always work.
 */

const emailRule = z.string().min(3).max(254).email();
const passwordRule = z.string().min(8).max(200);

const registerBody = z.object({
  email: emailRule,
  name: z.string().min(1).max(120).optional(),
  password: passwordRule,
});

const loginBody = z.object({
  email: emailRule,
  password: z.string().min(1).max(200),
});

function publicUser(u: { id: string; email: string; name: string | null; role: string }) {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

async function issueToken(userId: string, name?: string) {
  const raw = mintToken();
  const expiresAt = tokenExpiry();
  await db().authToken.create({
    data: {
      userId,
      tokenHash: hashToken(raw),
      ...(name ? { name } : {}),
      expiresAt,
    },
  });
  return { token: raw, expiresAt: expiresAt.toISOString() };
}

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/register', async (req, reply) => {
    const body = parseOrThrow(registerBody, req.body);
    const email = body.email.toLowerCase();
    const existing = await db().user.findUnique({ where: { email } });
    if (existing) {
      throw new ApiError('USER_EXISTS', `Email ${email} is already registered`, 409);
    }
    const created = await db().user.create({
      data: {
        email,
        ...(body.name ? { name: body.name } : {}),
        authRef: await hashPassword(body.password),
        role: 'tester',
      },
    });
    const session = await issueToken(created.id, 'register');
    return reply.code(201).send({ user: publicUser(created), ...session });
  });

  app.post('/auth/login', async (req, reply) => {
    const body = parseOrThrow(loginBody, req.body);
    const email = body.email.toLowerCase();
    const user = await db().user.findUnique({ where: { email } });
    const ok = user ? await verifyPassword(body.password, user.authRef) : false;
    if (!user || !ok) {
      throw new ApiError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
    }
    const session = await issueToken(user.id, 'login');
    return reply.code(200).send({ user: publicUser(user), ...session });
  });

  app.post('/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      await db().authToken.deleteMany({ where: { tokenHash: hashToken(header.slice(7).trim()) } });
    }
    return reply.code(200).send({ ok: true });
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (req) => {
    const user = await db().user.findUnique({ where: { id: req.user!.id } });
    if (!user) throw new ApiError('UNAUTHORIZED', 'Unknown user', 401);
    return publicUser(user);
  });
}
