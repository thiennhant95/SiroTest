/**
 * Static host for the tiny fixture target app (apps/fixture/login.html).
 * Started by Playwright webServer (see e2e/playwright.config.ts).
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(resolve(ROOT, 'apps', 'fixture', 'login.html'), 'utf8');
const PORT = Number(process.env.FIXTURE_PORT ?? 3123);

createServer((req, res) => {
  const url = req.url ?? '/';
  if (url === '/fixture/login' || url === '/' || url.startsWith('/#/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(HTML);
  } else if (url === '/fixture/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, fixture: 'login' }));
  } else {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`[e2e] fixture app on http://127.0.0.1:${PORT}/fixture/login`));
