/**
 * Public entry point of `@playwright-studio/action-sdk` (P2).
 *
 * Contract + validation + trusted-directory loader for Studio plugins.
 * Plugins are trusted Developer/Admin code (no sandbox — see loader.ts);
 * they stay OFF unless `ALLOW_PLUGINS=1`.
 */
export type {
  PluginContext,
  PluginParamSchema,
  PluginRegistry,
  PluginStepDef,
  PluginStepSchema,
  StudioPlugin,
} from './types.js';
export { definePlugin } from './define.js';
export {
  PLUGIN_TYPE_PATTERN,
  PluginValidationError,
  validatePluginManifest,
  validatePluginParams,
} from './validate.js';
export {
  describePlugin,
  isPluginsEnabled,
  PluginLoadError,
  pluginsDir,
  loadPluginsFromDir,
  type LoadedPlugins,
} from './loader.js';
