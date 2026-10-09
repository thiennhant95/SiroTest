/**
 * SiroTest control-plane MCP server (stdio).
 *
 * Exposes Studio projects/tests/runs/healing/AI as model tools over the
 * EXISTING Studio REST API — this package owns no browser, no database, no
 * secrets. Auth: `STUDIO_TOKEN` Bearer header (see config.ts).
 *
 * Client config (opencode `~/.config/opencode/opencode.json`, Claude
 * Desktop, Cursor, …):
 *   { "mcp": { "sirotest": {
 *     "type": "local",
 *     "command": ["node", "D:/path/to/playwright-vv/apps/mcp/dist/index.js"],
 *     "environment": { "STUDIO_API_URL": "http://127.0.0.1:3001", "STUDIO_TOKEN": "<token>" },
 *     "enabled": true } } }
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { StudioClient } from './client.js';
import { TOOL_DEFS } from './tools.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new StudioClient(config.apiBase, config.token);
  const server = new McpServer({ name: 'sirotest', version: '0.1.0' });
  for (const def of TOOL_DEFS) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.shape }, async (args) => def.run(client, args));
  }
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  console.error(`sirotest-mcp failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
