import type { PluginContext, PluginStepSchema, StudioPlugin } from './types.js';
import { validatePluginManifest, validatePluginParams } from './validate.js';

/**
 * Authoring helper: validates the manifest immediately (fail fast at
 * `require()` time) and returns it unchanged. Usage in a plugin file:
 *
 * ```js
 * const { definePlugin } = require('@playwright-studio/action-sdk');
 * module.exports = definePlugin({
 *   name: 'kv-helpers',
 *   version: '1.0.0',
 *   steps: [{
 *     type: 'plugin:kv.fillMasked',
 *     description: 'Fill a field and mask the value in reports',
 *     schema: { required: ['label', 'value'], properties: {
 *       label: { type: 'string' }, value: { type: 'string', secret: true },
 *     } },
 *     async execute({ page, params }) {
 *       await page.getByLabel(params.label).fill(process.env[params.value] ?? params.value);
 *     },
 *   }],
 * });
 * ```
 *
 * NOTE on secrets: a `secret: true` param must be passed as a `{{VARIABLE}}`
 * reference by the test author; the plugin resolves it at run time from
 * `ctx.env` (never persisted, redacted in logs by the runner).
 */
export function definePlugin(plugin: StudioPlugin): StudioPlugin {
  validatePluginManifest(plugin);
  return plugin;
}

export type { PluginContext, PluginStepSchema, StudioPlugin };
export { validatePluginManifest, validatePluginParams };
