import { buildApp } from "./app.js";
import { recoverIncompleteRunsOnBoot } from "./runner-store.js";

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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
