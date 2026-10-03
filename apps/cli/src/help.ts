/** `--help` text for the Studio CI CLI (no secrets, no placeholders). */
export const HELP_TEXT = `studio — Studio CI trigger (calls the server HTTP API; never runs tests locally)

Usage:
  studio run --api URL --token TOKEN --test <id> --env <id> [options]
  studio suite-run --api URL --token TOKEN --suite <id> --env <id> [options]
  studio export --api URL --token TOKEN (--test <id>|--run <id>|--suite-run <id>) -o <file> [options]
  studio trigger-schedules --once [options]
  studio help [command] | studio --help | studio <command> --help

run options:
  --test <id>         Test id (required)
  --env <id>          Environment id (required)
  --browser <name>    chromium|firefox|webkit (default chromium)
  --headed            Run headed (default headless)
  --dataset <id>      P1 data-driven dataset embedded in the definition
  --row <n>           Single 0-based row (requires --dataset)
  --wait              Poll GET /runs/:id until terminal, then exit by status
  --timeout-ms <n>    Wait deadline in ms (default 600000, 0 = no deadline)
  --interval-ms <n>   Poll interval in ms (default 2000, min 100)

suite-run options:
  --suite <id>        Suite id (required)
  --env <id>          Environment id (required)
  --browser, --headed, --wait, --timeout-ms, --interval-ms  (as above)
  --retries <n>       Per-test retries 0..5 (default 0)
  --parallel <n>      1 = sequential, 2 = queue-capped parallel (default 2)

export options:
  --test <id>         Export compiled spec (--format spec, the only choice)
  --run <id>          Export single-run JUnit (--format junit, the only choice)
  --suite-run <id>    Export suite-run JUnit (--format junit, the only choice)
  --dataset <id>      Compile the spec against a dataset (with --test only)
  -o, --out <file>    Output file (required)

trigger-schedules options (local mode — run on the server host):
  --once              Fire all due schedules a single time (required)
  --database-url <u>  Server DB URL (or env DATABASE_URL)
  --server-dist <dir> Compiled server dist dir holding scheduler.js
                      (or env STUDIO_SERVER_DIST; default: ../server/dist)
  Needs the built server (pnpm --filter @vv/server build) and DATABASE_URL.

Global options:
  --api <url>         Server base URL, e.g. http://127.0.0.1:3001 (or STUDIO_API_URL)
  --token <token>     Bearer token (or STUDIO_TOKEN; never printed to logs)

Environment:
  STUDIO_API_URL, STUDIO_TOKEN, DATABASE_URL, STUDIO_SERVER_DIST

Exit codes:
  0  passed (or accepted/written for non-wait commands)
  1  failed (run failed, or the CLI/API call itself errored)
  2  cancelled
  3  --wait timed out before the run settled
  64 usage/config error (bad flags, missing token, missing DATABASE_URL)

Examples:
  studio run --api http://127.0.0.1:3001 --token $STUDIO_TOKEN --test t1 --env e1
  studio run --api http://127.0.0.1:3001 --token $STUDIO_TOKEN --test t1 --env e1 --wait
  studio suite-run --api http://127.0.0.1:3001 --token $STUDIO_TOKEN --suite s1 --env e1 --wait
  studio export --api http://127.0.0.1:3001 --token $STUDIO_TOKEN --run r1 -o junit.xml
  studio trigger-schedules --once
`;

const TOPICS: Record<string, string> = {
  run: 'studio run — start one test run (POST /api/v1/tests/:id/runs).\n\nWithout --wait it prints the run id and exits 0. With --wait it polls\nGET /api/v1/runs/:id every --interval-ms until the run is passed, failed\nor cancelled (or --timeout-ms elapses), prints the summary incl. artifact\npaths, and exits 0/1/2 (3 on timeout).\n',
  'suite-run':
    'studio suite-run — start one suite execution (POST /api/v1/suites/:sid/runs).\n\nWithout --wait it prints the suiteRunId and exits 0. With --wait it polls\nGET /api/v1/suite-runs/:id until the aggregate status is terminal and\nprints the per-test rollup.\n',
  export:
    'studio export — download compiled spec or JUnit XML.\n\n--test <id>      -> GET /api/v1/tests/:id/export?format=spec (+ --dataset)\n--run <id>       -> GET /api/v1/runs/:id/export?format=junit\n--suite-run <id> -> GET /api/v1/suite-runs/:id/export?format=junit\n\n-o <file> is required.\n',
  'trigger-schedules':
    'studio trigger-schedules --once — single scheduler pass for external cron.\n\nRuns on the server host (same DATABASE_URL as the server) and fires every\ndue schedule once, reusing the in-process ticker logic\n(apps/server/src/scheduler.ts). Intended for Task Scheduler / cron when\nSCHEDULER_DISABLED=1. Prints checked/due/fired/skipped/failed counts and\nexits 0 (1 when any schedule failed).\n',
};

export function helpFor(topic?: string): string {
  if (topic && TOPICS[topic]) return `${HELP_TEXT}\n${TOPICS[topic]}`;
  return HELP_TEXT;
}
