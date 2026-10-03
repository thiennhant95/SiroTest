/**
 * action-sdk contract tests (node:test, run after build).
 * Covers: definePlugin() passthrough + fail-fast, validatePluginManifest()
 * (name/version/steps/type-prefix/execute/schema edges) and
 * validatePluginParams() (required/defaults/secrets/unknown keys).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { definePlugin } from '../src/index.js';
import { PluginValidationError, validatePluginManifest, validatePluginParams } from '../src/index.js';
import type { StudioPlugin } from '../src/index.js';

const okPlugin = (): StudioPlugin => ({
  name: 'kv-helpers',
  version: '1.0.0',
  steps: [
    {
      type: 'plugin:kv.fillMasked',
      description: 'fill + mask',
      schema: {
        required: ['label', 'value'],
        properties: {
          label: { type: 'string' },
          value: { type: 'string', secret: true },
        },
      },
      async execute() { /* test double */ },
    },
  ],
});

describe('definePlugin', () => {
  it('returns the manifest unchanged when valid', () => {
    const p = okPlugin();
    assert.equal(definePlugin(p), p);
  });

  it('throws fail-fast on an invalid manifest', () => {
    assert.throws(() => definePlugin({ name: 'x' } as unknown as StudioPlugin), PluginValidationError);
  });
});

describe('validatePluginManifest', () => {
  it('accepts a minimal valid manifest', () => {
    validatePluginManifest(okPlugin());
  });

  it('rejects non-objects', () => {
    assert.throws(() => validatePluginManifest(null), PluginValidationError);
    assert.throws(() => validatePluginManifest('plugin:kv'), PluginValidationError);
  });

  it('rejects bad names and versions', () => {
    const p = okPlugin();
    assert.throws(() => validatePluginManifest({ ...p, name: '../evil' }), PluginValidationError);
    assert.throws(() => validatePluginManifest({ ...p, name: '' }), PluginValidationError);
    assert.throws(() => validatePluginManifest({ ...p, version: 'v1' }), PluginValidationError);
    assert.throws(() => validatePluginManifest({ ...p, version: '' }), PluginValidationError);
  });

  it('rejects empty/missing/oversized steps', () => {
    const p = okPlugin();
    assert.throws(() => validatePluginManifest({ ...p, steps: [] }), PluginValidationError);
    assert.throws(() => validatePluginManifest({ name: 'a', version: '1.0.0' }), PluginValidationError);
    assert.throws(
      () => validatePluginManifest({ ...p, steps: Array.from({ length: 51 }, (_, i) => ({ type: `plugin:a.s${i}`, execute() { } })) }),
      PluginValidationError,
    );
  });

  it('requires the plugin: prefix, uniqueness and execute()', () => {
    const p = okPlugin();
    assert.throws(
      () => validatePluginManifest({ ...p, steps: [{ type: 'fill', execute() { } }] }),
      /plugin:/,
    );
    assert.throws(
      () => validatePluginManifest({ ...p, steps: [...p.steps, ...p.steps] }),
      /duplicate/,
    );
    assert.throws(
      () => validatePluginManifest({ ...p, steps: [{ type: 'plugin:a.b' }] }),
      /execute/,
    );
  });

  it('rejects schemas with unknown required params or non-string props', () => {
    const p = okPlugin();
    assert.throws(
      () => validatePluginManifest({
        ...p,
        steps: [{ type: 'plugin:a.b', schema: { required: ['ghost'], properties: {} }, execute() { } }],
      }),
      /undeclared/,
    );
    assert.throws(
      () => validatePluginManifest({
        ...p,
        steps: [{ type: 'plugin:a.b', schema: { properties: { n: { type: 'number' } } }, execute() { } }],
      }),
      /string/,
    );
  });
});

describe('validatePluginParams', () => {
  const schema = okPlugin().steps[0]!.schema!;

  it('applies defaults and returns effective params', () => {
    const withDefault = {
      required: [] as string[],
      properties: { a: { type: 'string' as const }, b: { type: 'string' as const, default: 'dflt' } },
    };
    assert.deepEqual(validatePluginParams('plugin:x.y', { a: 'v' }, withDefault), { a: 'v', b: 'dflt' });
  });

  it('rejects missing required params', () => {
    assert.throws(() => validatePluginParams('plugin:kv.fillMasked', { label: 'Email' }, schema), /value/);
  });

  it('rejects undeclared params and non-string values', () => {
    assert.throws(() => validatePluginParams('plugin:kv.fillMasked', { label: 'E', value: '{{PW}}', extra: '1' }, schema), /undeclared/);
    assert.throws(
      () => validatePluginParams('plugin:kv.fillMasked', { label: 'E', value: 42 }, schema),
      /must be a string/,
    );
  });

  it('secret params require a {{VARIABLE}} reference (never plaintext)', () => {
    assert.throws(
      () => validatePluginParams('plugin:kv.fillMasked', { label: 'E', value: 'plaintext-pw' }, schema),
      /{{VARIABLE}}|VARIABLE/,
    );
    assert.deepEqual(
      validatePluginParams('plugin:kv.fillMasked', { label: 'E', value: '{{LOGIN_PW}}' }, schema),
      { label: 'E', value: '{{LOGIN_PW}}' },
    );
  });

  it('rejects non-record params', () => {
    assert.throws(() => validatePluginParams('plugin:x.y', 'nope', schema), /record/);
  });
});
