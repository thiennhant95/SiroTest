#!/usr/bin/env node
/**
 * cleanup-db.mjs — database retention companion to cleanup-artifacts.mjs
 * (07-runner/artifacts-reporting.md).
 *
 * Deletes terminal Run rows (passed/failed/cancelled) finished longer ago
 * than ARTIFACT_RETENTION_DAYS (default 30), plus their RunStep + Artifact
 * rows (deleted explicitly — never relies on FK cascades alone). Active
 * runs (queued/running) are NEVER touched. Run this BEFORE/AFTER
 * cleanup-artifacts.mjs with the same retention so DB and disk agree.
 *
 * Usage:
 *   node scripts/cleanup-db.mjs [--dry-run] [--retention-days N]
 *   pnpm cleanup:db            # real run
 *   pnpm cleanup:db:dry        # preview only
 *
 * Env: DATABASE_URL (required), ARTIFACT_RETENTION_DAYS (default 30).
 */
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dryRun =
  process.argv.includes('--dry-run') || process.argv.includes('--dry') || process.env.DRY_RUN === '1';
const retentionDays = Math.max(
  1,
  Math.floor(Number(arg('--retention-days', process.env.ARTIFACT_RETENTION_DAYS ?? '30')) || 30),
);
const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

// Fail fast with guidance instead of a raw Prisma connect error: without
// DATABASE_URL this tool may open (or create!) the wrong database file.
if (!process.env.DATABASE_URL) {
  console.error('[cleanup-db] refusing: DATABASE_URL is not set. Point it at the live server database (see SELFHOST-WINDOWS.md).');
  process.exit(2);
}

const { PrismaClient } = await import('@prisma/client');
const db = new PrismaClient();
try {
  const stale = await db.run.findMany({
    where: {
      status: { in: ['passed', 'failed', 'cancelled'] },
      OR: [{ finishedAt: { lt: cutoff } }, { finishedAt: null, startedAt: { lt: cutoff } }],
    },
    select: { id: true, status: true, finishedAt: true },
  });
  if (dryRun) {
    console.log(`[cleanup-db:dry] runs=${stale.length} expired (retention=${retentionDays}d)`);
    for (const r of stale.slice(0, 20)) {
      console.log(`[cleanup-db:dry] would remove run ${r.id} (${r.status}, finished=${r.finishedAt?.toISOString() ?? 'n/a'})`);
    }
    if (stale.length > 20) console.log(`[cleanup-db:dry] ... and ${stale.length - 20} more`);
  } else {
    let removed = 0;
    for (const r of stale) {
      await db.artifact.deleteMany({ where: { runId: r.id } });
      await db.runStep.deleteMany({ where: { runId: r.id } });
      await db.run.delete({ where: { id: r.id } });
      removed += 1;
    }
    console.log(`[cleanup-db] runs=${stale.length} expired removed=${removed} retention=${retentionDays}d`);
  }
} finally {
  await db.$disconnect();
}
