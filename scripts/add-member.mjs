#!/usr/bin/env node
/**
 * add-member.mjs — bootstrap/repair membership directly in the database.
 *
 * Normal onboarding is now the UI (Settings → Members, owner only). Use this
 * script only for cases the UI cannot solve:
 *   - the project owner is a legacy/dev stub account (nobody can log in as it),
 *   - automation/bootstrap on a fresh install.
 *
 * Usage:
 *   $env:DATABASE_URL='file:C:/SiroTest/hub/apps/server/app.db'
 *   node scripts/add-member.mjs user@company.com editor [projectId]
 *   node scripts/add-member.mjs user@company.com owner  --all
 *
 * Roles: viewer | editor | owner. `owner` is normally created with the project;
 * granting it here is a deliberate recovery action (e.g. the original owner was
 * a dev stub). `--all` applies the membership to every project.
 *
 * Prints one line per project. Exits non-zero when the email has no User row
 * (they must Sign up in the UI first).
 *
 * NOTE: direct-DB write — no audit row.
 */
const { PrismaClient } = await import('@prisma/client');

const email = (process.argv[2] || '').trim().toLowerCase();
const role = (process.argv[3] || 'viewer').trim().toLowerCase();
const all = process.argv.includes('--all');
const projectId = (process.argv[4] || '').trim();

const ROLES = new Set(['viewer', 'editor', 'owner']);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (file:...app.db)');
  process.exit(2);
}
if (!email || !email.includes('@')) {
  console.error('usage: node scripts/add-member.mjs <user-email> [viewer|editor|owner] [projectId] [--all]');
  process.exit(2);
}
if (!ROLES.has(role)) {
  console.error('role must be viewer, editor or owner');
  process.exit(2);
}
if (!all && !projectId) {
  console.error('pass a projectId, or --all to apply to every project');
  process.exit(2);
}

const db = new PrismaClient();
try {
  const user = await db.user.findFirst({ where: { email } });
  if (!user) {
    console.error(`no User row for ${email} — they must Sign up in the UI first`);
    process.exit(3);
  }

  const projects = all
    ? await db.project.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } })
    : await db.project.findMany({ where: { id: projectId }, select: { id: true, name: true } });

  if (projects.length === 0) {
    console.error(all ? 'no projects found' : `project ${projectId} not found`);
    process.exit(3);
  }

  for (const project of projects) {
    const row = await db.projectMember.upsert({
      where: { projectId_userId: { projectId: project.id, userId: user.id } },
      update: { role },
      create: { projectId: project.id, userId: user.id, role },
    });
    console.log(`OK ${email} -> ${project.name} as ${row.role}`);
  }
} finally {
  await db.$disconnect();
}
