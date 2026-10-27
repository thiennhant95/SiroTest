#!/usr/bin/env node
/**
 * add-member.mjs — TEMPORARY BRSE onboarding helper (Tailscale phase).
 *
 * The product has no invite/member UI or API yet, so a new signup has no
 * project membership (403 on everything but their own projects). Until the
 * proper invite endpoint lands, IT runs this per BRSE after they Sign up:
 *
 *   $env:DATABASE_URL='file:D:/VietVang/Project/playwright-vv/apps/server/pilot-mizoguchi.db'
 *   node scripts/add-member.mjs brse@company.com editor
 *   node scripts/add-member.mjs brse2@company.com viewer [projectId]
 *
 * Defaults to the Demo Print project. Roles: viewer (read-only) | editor
 * (create/edit/run, no project delete). Prints the row; exits non-zero when
 * the email has no User row (they must Sign up in the UI first).
 *
 * NOTE: direct-DB write, no audit row (same as cleanup-db.mjs). Remove this
 * file once POST /projects/:id/members exists.
 */
const { PrismaClient } = await import('@prisma/client');

const DEFAULT_PROJECT = 'cmv83coa600004ctuor0oc3ar'; // Demo Print
const email = (process.argv[2] || '').trim().toLowerCase();
const role = (process.argv[3] || 'viewer').trim().toLowerCase();
const projectId = (process.argv[4] || DEFAULT_PROJECT).trim();

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (file:...pilot-mizoguchi.db)');
  process.exit(2);
}
if (!email || !email.includes('@')) {
  console.error('usage: node scripts/add-member.mjs <user-email> [viewer|editor] [projectId]');
  process.exit(2);
}
if (role !== 'viewer' && role !== 'editor') {
  console.error('role must be viewer or editor (owner is never granted by script)');
  process.exit(2);
}

const db = new PrismaClient();
try {
  const user = await db.user.findFirst({ where: { email } });
  if (!user) {
    console.error(`no User row for ${email} — they must Sign up in the UI first`);
    process.exit(3);
  }
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) {
    console.error(`project ${projectId} not found`);
    process.exit(3);
  }
  const row = await db.projectMember.upsert({
    where: { projectId_userId: { projectId, userId: user.id } },
    update: { role },
    create: { projectId, userId: user.id, role },
  });
  console.log(`OK ${email} -> ${project.name} as ${row.role}`);
} finally {
  await db.$disconnect();
}
