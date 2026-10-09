/**
 * config.ts — MCP server configuration from the environment.
 *
 * - `STUDIO_API_URL` — Studio server base URL (default `http://127.0.0.1:3001`).
 * - `STUDIO_TOKEN` — REQUIRED. Bearer token for the Studio REST API
 *   (same contract as the web UI and CLI). Read once at startup, placed only
 *   in the `Authorization` header — never in tool results, errors or logs.
 */
export interface McpConfig {
  apiBase: string;
  token: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const apiBase = (env['STUDIO_API_URL'] ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');
  const token = env['STUDIO_TOKEN'] ?? '';
  if (!token) {
    throw new Error('STUDIO_TOKEN is required (Bearer token for the Studio REST API)');
  }
  return { apiBase, token };
}
