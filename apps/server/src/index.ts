import { buildApp } from "./app.js";
import { recoverIncompleteRunsOnBoot } from "./runner-store.js";
import { startScheduler } from "./scheduler.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";

async function main() {
  const app = await buildApp();
  await app.listen({ port, host });
  // Crash recovery (runner-spec.md): settle `queued`/`running` rows left
  // behind by an abnormal teardown. Artifacts on disk are kept.
  try {
    const report = await recoverIncompleteRunsOnBoot();
    if (report.recoveredRuns.length > 0) {
      app.log.warn({ recoveredRuns: report.recoveredRuns }, "recovered incomplete runs from previous teardown");
    }
  } catch (err) {
    app.log.error({ err }, "boot recovery failed (server continues serving)");
  }
  // P1 scheduling ticker (scheduler.ts): only when this process is the real
  // entry (not imported by tests) and listening is not skipped. The ticker
  // unrefs its timer, so the HTTP listener — not the scheduler — owns the
  // process lifetime. Set SCHEDULER_DISABLED=1 for external-cron-only hosts
  // (then drive due schedules via `studio trigger-schedules --once`).
  const invokedAsEntry =
    process.argv[1]?.endsWith("index.js") === true || process.argv[1]?.endsWith("index.ts") === true;
  if (invokedAsEntry && process.env.SKIP_LISTEN !== "1" && process.env.SCHEDULER_DISABLED !== "1") {
    startScheduler({ log: app.log });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
