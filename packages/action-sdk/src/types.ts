/**
 * P2 action-SDK contract types.
 *
 * A Studio plugin is TRUSTED server-side code authored by a Developer/Admin,
 * reviewed before it is enabled (see loader.ts + ADR-006). Plugins run with
 * full Playwright `page` power inside the isolated run worker — there is NO
 * JS sandbox by design (documented non-goal). The safety model is:
 *  - OFF by default (`ALLOW_PLUGINS=1` required),
 *  - enablement/reload restricted to Developer/Admin roles (server route),
 *  - every failure is explicit (`PLUGIN_NOT_FOUND`, never a silent skip).
 */

/** One string parameter of a plugin step (JSON-schema-like, minimal). */
export interface PluginParamSchema {
  /** Currently only string params exist (secrets travel as {{VARIABLE}} refs). */
  type: 'string';
  description?: string;
  /** Max length guard (default 5000). */
  maxLength?: number;
  /** Static default applied when the caller omits the param. */
  default?: string;
  /** Secret params MUST be passed as {{VARIABLE}} refs — never literals. */
  secret?: boolean;
}

/** Minimal parameter schema for one plugin step type. */
export interface PluginStepSchema {
  /** Params the caller must supply (each must also be declared in properties). */
  required?: string[];
  /** Declared params (callers passing undeclared keys fail explicitly). */
  properties?: Record<string, PluginParamSchema>;
}

/** Runtime context handed to a plugin step's `execute`. */
export interface PluginContext<P extends Record<string, string> = Record<string, string>> {
  /** The Playwright `page` (or current tab handle) — full browser power. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any;
  /** Validated caller params (already defaulted, {{VAR}} NOT resolved here — resolve via env). */
  params: P;
  /** TestDefinition step id (for error messages / reporting). */
  stepId: string;
  /** Worker environment (secrets resolve via `process.env`-style lookups). */
  env: Record<string, string | undefined>;
}

/** One executable step contributed by a plugin. */
export interface PluginStepDef<P extends Record<string, string> = Record<string, string>> {
  /**
   * Globally unique step type. MUST start with the `plugin:` prefix, e.g.
   * `plugin:kv.fillMasked`. Dots group a plugin's steps; collisions across
   * plugins fail loading explicitly.
   */
  type: string;
  description?: string;
  schema?: PluginStepSchema;
  execute: (ctx: PluginContext<P>) => Promise<void> | void;
}

/** A plugin manifest: one npm-style unit authored by Dev/Admin. */
export interface StudioPlugin {
  /** Filesystem/id slug, e.g. `kv-helpers` ([A-Za-z0-9_-]+). */
  name: string;
  /** Semver-ish `x.y.z` (informational, surfaced in the docs UI). */
  version: string;
  description?: string;
  /** At least one step; step types must be unique within the manifest. */
  steps: PluginStepDef[];
}

/** Resolved lookup: step type -> owning plugin + step def. */
export type PluginRegistry = Map<string, { plugin: StudioPlugin; step: PluginStepDef }>;
