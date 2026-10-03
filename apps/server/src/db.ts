import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient | undefined;
let pragmaApplied = false;

export function db(): PrismaClient {
  if (!prisma) prisma = new PrismaClient();
  if (!pragmaApplied) {
    // SQLite durability under concurrency (single-host server + test suite
    // hammering one file): WAL lets readers proceed during writes and
    // busy_timeout turns would-be SQLITE_BUSY failures into short waits.
    // Best-effort and idempotent; journal_mode persists in the file.
    pragmaApplied = true;
    void prisma.$executeRawUnsafe('PRAGMA journal_mode=WAL').catch(() => undefined);
    void prisma.$executeRawUnsafe('PRAGMA busy_timeout = 5000').catch(() => undefined);
  }
  return prisma;
}
