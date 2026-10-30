// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  validateUnifiedManifest,
  parseUnifiedManifest,
  pluginManifestToUnified,
  registerPluginTools,
  isPluginUiEnabled,
  pluginUiCsp,
  renderPluginUiIframe,
  PluginManifestError,
} from '../src/bundle.js';
import { validateManifest } from '../src/manifest.js';

const FULL = {
  id: 'demo-bundle',
  name: 'Demo Bundle',
  version: '1.2.0',
  description: 'Hooks + skills + tools + MCP in one manifest',
  kinds: ['tool', 'hook', 'skill'],
  entry: 'index.js',
  hookEvents: [{ event: 'turn.ending' }],
  skillFiles: ['SKILL.md'],
  declaredTools: [
    { name: 'echo', description: 'Echo text' },
    { name: 'write_note', description: 'Writes a note', mutating: true },
  ],
  mcpServers: [{ id: 'fs', label: 'Filesystem', command: 'npx', args: ['-y', 'srv'], requiredEnv: [] }],
  evalSuite: { path: 'evals/suite.json', minScore: 0.8 },
  uiContribution: { entry: 'ui/panel.html', title: 'Demo Panel', embedding: 'sandboxed-iframe' },
};

describe('CA-23 unified bundle manifest', () => {
  it('parses a full bundle spanning hooks, skills, tools and MCP servers', () => {
    const m = parseUnifiedManifest(JSON.stringify(FULL));
    expect(m.mcpServers?.[0]?.command).toBe('npx');
    expect(m.declaredTools).toHaveLength(2);
    expect(m.hookEvents?.[0]?.event).toBe('turn.ending');
    expect(m.evalSuite?.minScore).toBe(0.8);
  });

  it('rejects unsafe skillFiles and a non-sandboxed UI contribution (CA-24)', () => {
    expect(() => validateUnifiedManifest({ ...FULL, skillFiles: ['../escape.md'] })).toThrow(PluginManifestError);
    expect(() => validateUnifiedManifest({ ...FULL, uiContribution: { entry: 'ui/x.html', title: 'X', embedding: 'inline' } })).toThrow(/sandboxed-iframe/);
  });

  it('converts a legacy plugin manifest', () => {
    const legacy = validateManifest({ id: 'old-ui', name: 'Old', version: '1.0.0', description: 'd', kinds: ['ui'], ui: { dir: 'public', title: 'P' } });
    const u = pluginManifestToUnified(legacy);
    expect(u.uiContribution?.embedding).toBe('sandboxed-iframe');
  });
});

describe('CA-23 plugin tool registration + governance', () => {
  it('registers read tools namespaced and denies mutating tools by default', async () => {
    const registry = new Map();
    const audits: string[] = [];
    const res = await registerPluginTools(registry as never, validateUnifiedManifest(FULL), {
      handlerFor: () => async () => ({ ok: true }),
      audit: (a) => audits.push(a),
    });
    expect(res.registered).toEqual(['plugin:demo-bundle:echo']);
    expect(res.denied[0]?.tool).toBe('plugin:demo-bundle:write_note');
    expect(registry.has('plugin:demo-bundle:echo')).toBe(true);
    expect(audits).toContain('plugin.tool.denied');
  });

  it('registers a mutating tool only with explicit approval', async () => {
    const registry = new Map();
    const res = await registerPluginTools(registry as never, validateUnifiedManifest(FULL), {
      handlerFor: () => async () => 1,
      approveTool: ({ mutating }) => mutating,
    });
    // echo denied by this hook (returns false for non-mutating), write_note allowed
    expect(res.registered).toEqual(['plugin:demo-bundle:write_note']);
  });
});

describe('CA-24 plugin UI contribution (reduced slice)', () => {
  it('is default-off and renders a sandboxed iframe with a nonce CSP', () => {
    expect(isPluginUiEnabled(undefined)).toBe(false);
    expect(isPluginUiEnabled('true')).toBe(true);
    const m = validateUnifiedManifest(FULL);
    const html = renderPluginUiIframe({ pluginId: m.id, contribution: m.uiContribution!, src: '/api/plugins/demo-bundle/ui/panel.html', nonce: 'abc123' });
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('allow-same-origin');
    expect(pluginUiCsp('abc123')).toContain("connect-src 'none'");
    expect(pluginUiCsp('abc123')).toContain("script-src 'nonce-abc123'");
  });
});
