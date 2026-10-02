/**
 * Studio API host for E2E (real Fastify app + isolated SQLite, no mocks).
 * Started by Playwright webServer (see e2e/playwright.config.ts).
 */
process.env.SKIP_LISTEN = '1';
process.env.ALLOW_PRIVATE_TARGETS = '1';

const { ensureIntegrationDb } = await import('../../tests/integration/helpers.js');
const { buildApp } = await import('../../apps/server/src/app.js');

await ensureIntegrationDb();
const PORT = Number(process.env.API_PORT ?? 3101);
const app = await buildApp();
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`[e2e] studio api on http://127.0.0.1:${PORT} (db: integration-test.db)`);
