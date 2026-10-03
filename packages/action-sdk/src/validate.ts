import type { PluginStepSchema, StudioPlugin } from './types.js';

/** Step types must be globally unique and namespaced: `plugin:<name>`. */
export const PLUGIN_TYPE_PATTERN = /^plugin:[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/;
const VAR_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/;

export class PluginValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginValidationError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate a plugin manifest. Throws PluginValidationError with an explicit
 * reason — never returns a half-valid manifest. Pure (no mutation).
 */
export function validatePluginManifest(manifest: unknown): asserts manifest is StudioPlugin {
  if (!isRecord(manifest)) {
    throw new PluginValidationError('plugin manifest must be an object exported via module.exports (or ESM default export)');
  }
  const { name, version, steps } = manifest as Record<string, unknown>;
  if (typeof name !== 'string' || !PLUGIN_NAME_PATTERN.test(name)) {
    throw new PluginValidationError(
      `plugin "name" must match ${PLUGIN_NAME_PATTERN} (got ${JSON.stringify(name) ?? 'missing'})`,
    );
  }
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new PluginValidationError(
      `plugin "${name}" version must look like x.y.z (got ${JSON.stringify(version) ?? 'missing'})`,
    );
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new PluginValidationError(`plugin "${name}" must declare a non-empty "steps" array`);
  }
  if (steps.length > 50) {
    throw new PluginValidationError(`plugin "${name}" declares ${steps.length} steps (max 50)`);
  }
  const seen = new Set<string>();
  steps.forEach((s, i) => {
    const where = `steps[${i}]`;
    if (!isRecord(s)) {
      throw new PluginValidationError(`plugin "${name}" ${where} must be an object`);
    }
    const type = (s as Record<string, unknown>)['type'];
    if (typeof type !== 'string' || !PLUGIN_TYPE_PATTERN.test(type)) {
      throw new PluginValidationError(
        `plugin "${name}" ${where}.type must match ${PLUGIN_TYPE_PATTERN} (the "plugin:" prefix is mandatory, got ${JSON.stringify(type)})`,
      );
    }
    if (seen.has(type)) {
      throw new PluginValidationError(`plugin "${name}" declares duplicate step type "${type}"`);
    }
    seen.add(type);
    const execute = (s as Record<string, unknown>)['execute'];
    if (typeof execute !== 'function') {
      throw new PluginValidationError(`plugin "${name}" step "${type}" must export an execute(ctx) function`);
    }
    const schema = (s as Record<string, unknown>)['schema'];
    if (schema !== undefined) validateStepSchema(name, type, schema);
  });
}

function validateStepSchema(pluginName: string, stepType: string, schema: unknown): asserts schema is PluginStepSchema {
  if (!isRecord(schema)) {
    throw new PluginValidationError(`plugin "${pluginName}" step "${stepType}" schema must be an object`);
  }
  const { required, properties } = schema as Record<string, unknown>;
  let props: Record<string, unknown> = {};
  if (properties !== undefined) {
    if (!isRecord(properties)) {
      throw new PluginValidationError(`plugin "${pluginName}" step "${stepType}" schema.properties must be a record`);
    }
    props = properties;
    for (const [k, v] of Object.entries(props)) {
      if (!isRecord(v) || (v as Record<string, unknown>)['type'] !== 'string') {
        throw new PluginValidationError(
          `plugin "${pluginName}" step "${stepType}" param "${k}" must declare { type: 'string', ... } (only string params exist in P2)`,
        );
      }
      const maxLength = (v as Record<string, unknown>)['maxLength'];
      if (maxLength !== undefined && !(typeof maxLength === 'number' && Number.isInteger(maxLength) && maxLength > 0)) {
        throw new PluginValidationError(
          `plugin "${pluginName}" step "${stepType}" param "${k}" maxLength must be a positive integer`,
        );
      }
    }
  }
  if (required !== undefined) {
    if (!Array.isArray(required) || !required.every((r) => typeof r === 'string')) {
      throw new PluginValidationError(`plugin "${pluginName}" step "${stepType}" schema.required must be an array of strings`);
    }
    for (const r of required as string[]) {
      if (!Object.prototype.hasOwnProperty.call(props, r)) {
        throw new PluginValidationError(
          `plugin "${pluginName}" step "${stepType}" requires undeclared param "${r}" (add it to schema.properties)`,
        );
      }
    }
  }
}

/**
 * Validate caller params against a step schema and apply defaults.
 * Returns the effective params. Throws PluginValidationError explicitly:
 * missing required, undeclared key, non-string value, over maxLength, or a
 * plaintext literal for a `secret: true` param (must be a {{VARIABLE}} ref so
 * the runner redacts it and never inlines it into generated code).
 */
export function validatePluginParams(
  stepType: string,
  params: unknown,
  schema?: PluginStepSchema,
): Record<string, string> {
  const rec = isRecord(params) ? (params as Record<string, unknown>) : {};
  if (params !== undefined && !isRecord(params)) {
    throw new PluginValidationError(`plugin step "${stepType}" params must be a record of strings`);
  }
  const props = schema?.properties ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (!Object.prototype.hasOwnProperty.call(props, k)) {
      throw new PluginValidationError(
        `plugin step "${stepType}" passes undeclared param "${k}" (declared: ${Object.keys(props).join(', ') || 'none'})`,
      );
    }
    if (typeof v !== 'string') {
      throw new PluginValidationError(`plugin step "${stepType}" param "${k}" must be a string`);
    }
    const decl = props[k]!;
    if (typeof decl.maxLength === 'number' && v.length > decl.maxLength) {
      throw new PluginValidationError(
        `plugin step "${stepType}" param "${k}" is ${v.length} chars (max ${decl.maxLength})`,
      );
    }
    if (decl.secret === true && !VAR_PATTERN.test(v)) {
      throw new PluginValidationError(
        `plugin step "${stepType}" secret param "${k}" must be a {{VARIABLE}} reference so the secret resolves at run time, never inlined`,
      );
    }
    out[k] = v;
  }
  for (const [k, decl] of Object.entries(props)) {
    if (out[k] === undefined) {
      if (typeof decl.default === 'string') {
        if (decl.secret === true && !VAR_PATTERN.test(decl.default)) {
          throw new PluginValidationError(
            `plugin step "${stepType}" secret param "${k}" has a plaintext default — defaults for secret params must be {{VARIABLE}} references`,
          );
        }
        out[k] = decl.default;
      } else if ((schema?.required ?? []).includes(k)) {
        throw new PluginValidationError(`plugin step "${stepType}" is missing required param "${k}"`);
      }
    }
  }
  return out;
}
