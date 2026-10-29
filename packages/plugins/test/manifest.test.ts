// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { PluginManifestError, parseManifest, validateManifest } from '../src/manifest.js';

const VALID = {
  id: 'demo-toolkit',
  name: 'Demo Toolkit',
  version: '1.0.0',
  description: 'Demo tools',
  kinds: ['tool'],
  entry: 'index.js',
};

describe('validateManifest', () => {
  it('accepts a valid executable manifest and normalizes it', () => {
    const m = validateManifest(VALID);
    expect(m.id).toBe('demo-toolkit');
    expect(m.kinds).toEqual(['tool']);
    expect(m.entry).toBe('index.js');
  });

  it('accepts skill-only and ui manifests without entry', () => {
    expect(validateManifest({ ...VALID, kinds: ['skill'], entry: undefined }).kinds).toEqual(['skill']);
    const ui = validateManifest({ ...VALID, kinds: ['ui'], entry: undefined, ui: { dir: 'public', title: 'Panel' } });
    expect(ui.ui).toEqual({ dir: 'public', title: 'Panel' });
  });

  it('rejects a bad id, version, and empty name with all issues listed', () => {
    try {
      validateManifest({ ...VALID, id: 'Bad ID!', version: 'one', name: ' ' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PluginManifestError);
      const issues = (err as PluginManifestError).issues.join(' ');
      expect(issues).toMatch(/id/);
      expect(issues).toMatch(/version/);
      expect(issues).toMatch(/name/);
    }
  });

  it('requires entry for executable kinds', () => {
    expect(() => validateManifest({ ...VALID, entry: undefined })).toThrow(/entry is required/);
    expect(() => validateManifest({ ...VALID, kinds: ['channel'], entry: undefined })).toThrow(/entry is required/);
    expect(() => validateManifest({ ...VALID, kinds: ['hook'], entry: undefined })).toThrow(/entry is required/);
  });

  it('rejects traversal / absolute entry paths', () => {
    expect(() => validateManifest({ ...VALID, entry: '../escape.js' })).toThrow(/entry/);
    expect(() => validateManifest({ ...VALID, entry: '/abs/path.js' })).toThrow(/entry/);
    expect(() => validateManifest({ ...VALID, entry: 'a\\b.js' })).toThrow(/entry/);
  });

  it('rejects unknown / duplicate kinds and empty kinds', () => {
    expect(() => validateManifest({ ...VALID, kinds: ['tool', 'wizard'] })).toThrow(/unknown kind/);
    expect(() => validateManifest({ ...VALID, kinds: ['tool', 'tool'] })).toThrow(/duplicate kind/);
    expect(() => validateManifest({ ...VALID, kinds: [] })).toThrow(/kinds/);
  });

  it('requires ui spec for ui kind and validates permissions', () => {
    expect(() => validateManifest({ ...VALID, kinds: ['ui'], entry: undefined })).toThrow(/ui \{ dir, title \}/);
    expect(() => validateManifest({ ...VALID, permissions: { env: ['not a name'] } })).toThrow(/permissions\.env/);
    expect(() => validateManifest({ ...VALID, permissions: { network: 'yes' } })).toThrow(/permissions\.network/);
    const ok = validateManifest({ ...VALID, permissions: { network: true, env: ['MY_TOKEN'] } });
    expect(ok.permissions).toEqual({ network: true, env: ['MY_TOKEN'] });
  });

  it('parseManifest wraps JSON syntax errors', () => {
    expect(() => parseManifest('{nope')).toThrow(PluginManifestError);
    expect(parseManifest(JSON.stringify(VALID)).id).toBe('demo-toolkit');
  });
});
