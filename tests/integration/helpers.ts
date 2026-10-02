/**
 * Shared helpers for Day 8-10 integration tests (12-testing/test-strategy.md).
 * - Isolated SQLite file: prisma/integration-test.db (never touches dev.db).
 * - Auth: P0 `x-user-id` header; the user row is seeded for FK `createdBy`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

export const TEST_USER_ID = 'u_integration';
export const TEST_USER_EMAIL = 'integration@test.local';

export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
}

export function integrationDbPath(): string {
  return resolve(repoRoot(), 'prisma', 'integration-test.db');
}

export function integrationDbUrl(): string {
  return `file:${integrationDbPath().replace(/\\/g, '/')}`;
}

function prismaCli(): string {
  return resolve(repoRoot(), 'node_modules', 'prisma', 'build', 'index.js');
}

/**
 * Point this process at the integration DB, create tables if needed, seed user.
 * Idempotent: safe to call from every test file's before() hook.
 * Pass { reset: true } (setup script only) to start from an empty database.
 */
export async function ensureIntegrationDb(opts: { reset?: boolean } = {}): Promise<void> {
  process.env.DATABASE_URL = integrationDbUrl();
  // Documented escape hatch (apps/server/src/security.ts): the self-hosted
  // /fixture target runs on loopback, which the SSRF guard blocks by default.
  process.env.ALLOW_PRIVATE_TARGETS = '1';
  const { PrismaClient } = await import('@prisma/client');
  if (opts.reset) {
    const { rmSync } = await import('node:fs');
    rmSync(integrationDbPath(), { force: true });
  }
  let needsPush = opts.reset || !existsSync(integrationDbPath());
  if (!needsPush) {
    try {
      const probe = new PrismaClient();
      await probe.$queryRaw`SELECT 1 AS one FROM "Project" LIMIT 1`;
      await probe.$disconnect();
    } catch {
      needsPush = true;
    }
  }
  if (needsPush) {
    execFileSync(
      process.execPath,
      [prismaCli(), 'db', 'push', '--schema', resolve(repoRoot(), 'prisma', 'schema.prisma'), '--skip-generate'],
      { stdio: 'pipe', env: { ...process.env, DATABASE_URL: integrationDbUrl() } },
    );
  }
  const db = new PrismaClient();
  try {
    await db.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: { id: TEST_USER_ID, email: TEST_USER_EMAIL, authRef: 'integration-test', role: 'tester' },
    });
  } finally {
    await db.$disconnect();
  }
}

export function authHeaders(): Record<string, string> {
  return { 'x-user-id': TEST_USER_ID };
}

export async function injectJson(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
) {
  // Never send `content-type: application/json` with an empty body:
  // Fastify rejects it with FST_ERR_CTP_EMPTY_JSON_BODY.
  const headers: Record<string, string> = { ...authHeaders() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.inject({
    method,
    url,
    headers,
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Semantic-locator target shortcut. */
export function labelTarget(value: string) {
  return { primary: { strategy: 'label', value } };
}

/**
 * Login flow against the tiny fixture app — mirrors examples/login-test.json
 * but with literal (non-secret) values so the stub runner can execute it.
 * Uses the P0-correct {{VAR}} pattern for the sensitive password field.
 */
export function loginFixtureDefinition(projectId: string, fixtureBaseUrl: string) {
  return {
    schemaVersion: '1.0',
    id: 'test_fixture_login',
    projectId,
    name: 'Fixture login',
    browser: 'chromium',
    baseUrl: fixtureBaseUrl,
    steps: [
      { id: 's1', type: 'goto', enabled: true, url: `${fixtureBaseUrl}/fixture/login` },
      { id: 's2', type: 'fill', enabled: true, target: labelTarget('Email'), value: 'tester@example.com' },
      {
        id: 's3', type: 'fill', enabled: true, target: labelTarget('Password'),
        value: '{{FIXTURE_PASSWORD}}', sensitive: true,
      },
      {
        id: 's4', type: 'click', enabled: true,
        target: { primary: { strategy: 'role', role: 'button', name: 'Login' } },
      },
      { id: 's5', type: 'assertVisible', enabled: true, target: { primary: { strategy: 'text', value: 'Dashboard' } } },
    ],
  };
}

/** Minimal valid step per P0 type (03-test-model/step-catalog.md). */
export function minimalStepFor(type: string): Record<string, unknown> {
  const target = labelTarget('Email');
  switch (type) {
    case 'goto': return { id: 's1', type, enabled: true, url: 'http://127.0.0.1:3123/fixture/login' };
    case 'waitForURL': return { id: 's1', type, enabled: true, url: 'http://127.0.0.1:3123/#/dashboard' };
    case 'waitForTimeout': return { id: 's1', type, enabled: true, milliseconds: 100 };
    case 'waitForElement': return { id: 's1', type, enabled: true, target };
    case 'fill': return { id: 's1', type, enabled: true, target, value: 'hello' };
    case 'press': return { id: 's1', type, enabled: true, target, key: 'Enter' };
    case 'select': return { id: 's1', type, enabled: true, target, value: 'VN' };
    case 'clear': case 'click': case 'doubleClick': case 'check': case 'uncheck':
    case 'hover': case 'assertVisible': case 'assertHidden':
    case 'assertEnabled': case 'assertDisabled': case 'assertChecked':
      return { id: 's1', type, enabled: true, target };
    case 'assertText': case 'assertContainsText': case 'assertValue':
      return { id: 's1', type, enabled: true, target, expected: 'hello' };
    case 'assertURL': return { id: 's1', type, enabled: true, expected: 'http://127.0.0.1:3123/#/dashboard' };
    case 'assertTitle': return { id: 's1', type, enabled: true, expected: 'VV Fixture' };
    case 'screenshot': return { id: 's1', type, enabled: true, name: 'final' };
    case 'reload': case 'goBack': case 'goForward':
      return { id: 's1', type, enabled: true };
    default: throw new Error(`minimalStepFor: unknown P0 step type "${type}"`);
  }
}
