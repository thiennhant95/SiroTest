/**
 * action-sdk loader tests (node:test, run after build).
 * Covers: ALLOW_PLUGINS=1 gate (default OFF), directory loading (CJS + ESM
 * entries), manifest validation on load, cross-plugin type conflicts, and
 * describePlugin() metadata redaction (no function source leaks).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describePlugin,
  isPluginsEnabled,
  loadPluginsFromDir,
  PluginLoadError,
  pluginsDir,
} from '../src/index.js';

let dir: string;
let prevAllow: string | undefined;
let prevDir: string | undefined;

before(() => {
  // Fixtures live directly under the package root so the CJS fixture can
  // require the built SDK via a stable relative path (no pnpm-link needed).
  dir = mkdtempSync(join(process.cwd(), '.tmp-plugin-fixtures-'));
  prevAllow = process.env.ALLOW_PLUGINS;
  prevDir = process.env.PLUGINS_DIR;
  delete process.env.ALLOW_PLUGINS;
  delete process.env.PLUGINS_DIR;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevAllow === undefined) delete process.env.ALLOW_PLUGINS;
  else process.env.ALLOW_PLUGINS = prevAllow;
  if (prevDir === undefined) delete process.env.PLUGINS_DIR;
  else process.env.PLUGINS_DIR = prevDir;
});

const CJS_PLUGIN = `
const { definePlugin } = require('../dist/src/index.js');
module.exports = definePlugin({
  name: 'cjs-one',
  version: '1.2.0',
  description: 'cjs fixture',
  steps: [{
    type: 'plugin:cjs.greet',
    description: 'greet step',
    schema: { required: ['who'], properties: { who: { type: 'string' } } },
    async execute() {},
  }],
});
`;

const ESM_PLUGIN = `
export default {
  name: 'esm-one',
  version: '0.0.1',
  steps: [{ type: 'plugin:esm.ping', async execute() {} }],
};
`;

describe('plugin gate', () => {
  it('is disabled by default (ALLOW_PLUGINS unset)', () => {
    assert.equal(isPluginsEnabled(), false);
  });

  it('refuses to load when disabled', async () => {
    await assert.rejects(() => loadPluginsFromDir(dir), /PLUGIN_DISABLED/);
  });

  it('pluginsDir() honors PLUGINS_DIR with a cwd fallback', () => {
    process.env.PLUGINS_DIR = dir;
    assert.equal(pluginsDir(), dir);
    delete process.env.PLUGINS_DIR;
    assert.ok(pluginsDir().endsWith('plugins'));
  });
});

describe('loadPluginsFromDir', () => {
  it('loads CJS + ESM entries and builds a unique registry', async () => {
    process.env.ALLOW_PLUGINS = '1';
    try {
      writeFileSync(join(dir, 'a-cjs.cjs'), CJS_PLUGIN);
      writeFileSync(join(dir, 'b-esm.mjs'), ESM_PLUGIN);
      writeFileSync(join(dir, 'notes.txt'), 'ignored');
      const loaded = await loadPluginsFromDir(dir);
      assert.equal(loaded.enabled, true);
      assert.equal(loaded.plugins.length, 2);
      assert.deepEqual([...loaded.registry.keys()].sort(), ['plugin:cjs.greet', 'plugin:esm.ping']);
      assert.equal(loaded.registry.get('plugin:cjs.greet')?.plugin.name, 'cjs-one');
      assert.equal(loaded.files.length, 2);
    } finally {
      delete process.env.ALLOW_PLUGINS;
    }
  });

  it('fails explicitly on cross-plugin step-type conflicts', async () => {
    process.env.ALLOW_PLUGINS = '1';
    try {
      const clashDir = mkdtempSync(join(dir, 'clash-'));
      writeFileSync(join(clashDir, 'a.cjs'), `module.exports = { name: 'one', version: '1.0.0', steps: [{ type: 'plugin:dup.step', execute() {} }] };`);
      writeFileSync(
        join(clashDir, 'b.cjs'),
        `module.exports = { name: 'clash', version: '1.0.0', steps: [{ type: 'plugin:dup.step', execute() {} }] };`,
      );
      await assert.rejects(() => loadPluginsFromDir(clashDir), /PLUGIN_TYPE_CONFLICT/);
    } finally {
      delete process.env.ALLOW_PLUGINS;
    }
  });

  it('fails explicitly on invalid manifests and unreadable dirs', async () => {
    process.env.ALLOW_PLUGINS = '1';
    try {
      const badDir = mkdtempSync(join(dir, 'bad-'));
      writeFileSync(join(badDir, 'bad.cjs'), `module.exports = { name: 'nope' };`);
      // Manifest validation surfaces as an explicit validation error (never silent).
      await assert.rejects(() => loadPluginsFromDir(badDir), /version must look like/);
      await assert.rejects(
        () => loadPluginsFromDir(join(tmpdir(), 'vv-sdk-does-not-exist-12345')),
        /PLUGIN_DIR_UNREADABLE/,
      );
    } finally {
      delete process.env.ALLOW_PLUGINS;
    }
  });
});

describe('describePlugin', () => {
  it('exposes metadata only (execute source never leaks)', () => {
    const meta = describePlugin({
      name: 'cjs-one',
      version: '1.2.0',
      steps: [{ type: 'plugin:cjs.greet', description: 'hi', execute: async () => { /* SECRET_FN */ } }],
    });
    const json = JSON.stringify(meta);
    assert.ok(!json.includes('SECRET_FN'), 'function source must not leak to clients');
    assert.ok(!json.includes('execute'), 'no execute key in metadata');
    assert.equal(meta.steps[0]?.type, 'plugin:cjs.greet');
  });
});
