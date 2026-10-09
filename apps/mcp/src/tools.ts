/**
 * tools.ts — SiroTest control-plane tools.
 *
 * Pure handlers over an injected StudioClient so they unit-test without a
 * server. Every handler returns `{ ok, result }` / `{ ok: false, error }`
 * JSON text — the model sees Studio errors explicitly, never a crash.
 * Healing approve/reject are DELIBERATELY absent: destructive review
 * decisions stay in the human UI (proposal-only principle).
 */
import { z } from 'zod';
import { StudioApiError, type StudioClient } from './client.js';

export interface ToolResult {
  [key: string]: unknown;
  content: [{ type: 'text'; text: string }];
}

const ok = (result: unknown): ToolResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, result }, null, 2) }],
});

const fail = (error: string): ToolResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }, null, 2) }],
});

async function guard<T>(fn: () => Promise<T>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof StudioApiError) return fail(`Studio API: ${err.message}`);
    return fail(`Tool failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const projectIdShape = { projectId: z.string().min(1).describe('Studio project id') };
const testIdShape = { testId: z.string().min(1).describe('Studio test id') };

export interface ToolDef {
  name: string;
  description: string;
  shape: Record<string, z.ZodTypeAny>;
  run: (client: StudioClient, args: Record<string, unknown>) => Promise<ToolResult>;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'studio_list_projects',
    description: 'List SiroTest projects (id + name). Start here to discover what exists.',
    shape: {},
    run: (c) => guard(() => c.listProjects()),
  },
  {
    name: 'studio_list_tests',
    description: 'List tests in a project (id + name). Optional tag filter.',
    shape: { ...projectIdShape, tag: z.string().optional().describe('Filter by test tag') },
    run: (c, a) => guard(() => c.listTests(str(a['projectId']), a['tag'] === undefined ? undefined : str(a['tag']))),
  },
  {
    name: 'studio_get_test',
    description: 'Get a test: step list (id/type/name) + count. Full definition only when includeDefinition=true (large).',
    shape: { ...testIdShape, includeDefinition: z.boolean().optional().describe('Include the full JSON definition') },
    run: async (c, a) =>
      guard(async () => {
        const t = await c.getTest(str(a['testId']));
        if (a['includeDefinition'] === true) return t;
        const { definitionJson: _omit, ...summary } = t;
        return summary;
      }),
  },
  {
    name: 'studio_export_spec',
    description: 'Export a test as a readable Playwright .spec.ts (same compiler the runner uses).',
    shape: { ...testIdShape },
    run: (c, a) => guard(() => c.exportSpec(str(a['testId']))),
  },
  {
    name: 'studio_create_run',
    description: 'Queue a test run (async). Returns runId — poll studio_get_run for the terminal status.',
    shape: {
      ...testIdShape,
      environmentId: z.string().min(1).describe('Environment id to run against'),
      browser: z.enum(['chromium', 'firefox', 'webkit']).optional(),
      headed: z.boolean().optional(),
    },
    run: (c, a) =>
      guard(() =>
        c.createRun(str(a['testId']), {
          environmentId: str(a['environmentId']),
          ...(typeof a['browser'] === 'string' ? { browser: a['browser'] as 'chromium' } : {}),
          ...(typeof a['headed'] === 'boolean' ? { headed: a['headed'] } : {}),
        }),
      ),
  },
  {
    name: 'studio_get_run',
    description: 'Get run status (queued/running/passed/failed/cancelled) + per-step statuses and truncated errors.',
    shape: { runId: z.string().min(1).describe('Run id from studio_create_run') },
    run: (c, a) => guard(() => c.getRun(str(a['runId']))),
  },
  {
    name: 'studio_list_healing',
    description: 'List pending locator-healing proposals for a test (from → to + verified evidence). Approval stays human-only in the UI.',
    shape: { ...testIdShape },
    run: (c, a) => guard(() => c.listHealing(str(a['testId']))),
  },
  {
    name: 'studio_parse_gherkin',
    description: 'Parse Vietnamese Gherkin (Tính năng/Bối cảnh/Kịch bản/Cho rằng/Khi/Thì) into step candidates. Unparsed lines are returned explicitly — never invent steps from them.',
    shape: { text: z.string().min(1).describe('Gherkin text') },
    run: (c, a) => guard(() => c.parseGherkin(str(a['text']))),
  },
  {
    name: 'studio_explain_run',
    description: 'Explain a failed/cancelled run: failure category + likely causes + suggested fixes (rules engine, Vietnamese).',
    shape: { runId: z.string().min(1).describe('Failed run id') },
    run: (c, a) => guard(() => c.explainRun(str(a['runId']))),
  },
];
