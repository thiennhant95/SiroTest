/**
 * Hermetic child spawn regression test.
 *
 * The isolated TEMP workdir has no node_modules of its own. The Playwright
 * child therefore resolves `@playwright/test` ONLY through NODE_PATH.
 * Relying on ambient luck (e.g. a hoisted copy visible via tsx-inherited
 * NODE_PATH) breaks fresh checkouts and CI — runTest must pass an explicit
 * NODE_PATH derived from the resolved CLI location.
 *
 * Run:  pnpm --filter @playwright-studio/runner test   (node --test tests/)
 * Imports compiled dist/ (CJS via createRequire), like recovery.test.mjs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { defaultPlaywrightCommand } = require('../dist/run.js');

describe('hermetic Playwright spawn (fresh-checkout runs)', () => {
  it('defaultPlaywrightCommand exposes a nodePath that resolves @playwright/test', () => {
    const cli = defaultPlaywrightCommand();
    assert.ok(cli.command, 'command set');
    assert.ok(Array.isArray(cli.baseArgs) && cli.baseArgs.length > 0, 'baseArgs set');
    assert.ok(typeof cli.nodePath === 'string' && cli.nodePath.length > 0, 'nodePath set');
    assert.ok(existsSync(cli.nodePath), `nodePath exists on disk: ${cli.nodePath}`);
    const pkg = createRequire(import.meta.url).resolve('@playwright/test/package.json', {
      paths: [cli.nodePath],
    });
    assert.ok(pkg.endsWith('package.json'), `resolves @playwright/test from nodePath: ${pkg}`);
  });
});
