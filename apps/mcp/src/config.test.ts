import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

describe('mcp config', () => {
  it('requires STUDIO_TOKEN', () => {
    assert.throws(() => loadConfig({}), /STUDIO_TOKEN is required/);
  });

  it('defaults the API URL and trims slashes', () => {
    assert.deepEqual(loadConfig({ STUDIO_TOKEN: 't' }), { apiBase: 'http://127.0.0.1:3001', token: 't' });
    assert.equal(loadConfig({ STUDIO_TOKEN: 't', STUDIO_API_URL: 'http://x:4000///' }).apiBase, 'http://x:4000');
  });
});
