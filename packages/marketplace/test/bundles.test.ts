// SPDX-License-Identifier: Apache-2.0
// Specialist packaging: bundles, first-run bootstrap, authoring
// scaffold, and registry manifest caching.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootstrapFirstRun,
  clearMarketplaceRegistryCache,
  getBundle,
  installBundle,
  listBundles,
  MarketplaceInstaller,
  MarketplaceRegistry,
  resolveBundle,
  scaffoldSkill,
} from '../src/index.js';

let dir: string;
let registryPath: string;

const entry = (kind: string, id: string): Record<string, unknown> => {
  const base = {
    id,
    kind,
    name: id,
    version: '1.0.0',
    creator: 'kriyadot',
    description: `${id} description`,
    license: 'Apache-2.0',
    priceCents: 0,
    tags: [],
    untrusted: false,
  };
  if (kind === 'skill') return { ...base, payload: { id, content: `# ${id}\n` } };
  if (kind === 'bot')
    return {
      ...base,
      payload: {
        id,
        name: id,
        description: 'bot',
        systemPrompt: 'You are a bot.',
        provider: 'groq',
        model: 'm',
        skills: [],
        tools: [],
        mcpServers: [],
      },
    };
  if (kind === 'mcp-server')
    return { ...base, payload: { id, label: id, command: 'true', args: [], requiredEnv: [] } };
  return { ...base, payload: { id, name: id, description: 'wf', nodes: [], edges: [] } };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-bundles-'));
  registryPath = join(dir, 'registry.json');
  const entries = [
    entry('bot', 'meeting-scribe'),
    entry('skill', 'meeting-notes'),
    entry('skill', 'git-hygiene'),
    entry('skill', 'cron-scheduling'),
    entry('mcp-server', 'postgres-local'),
  ];
  writeFileSync(registryPath, JSON.stringify({ entries }));
  clearMarketplaceRegistryCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearMarketplaceRegistryCache();
});

describe('bundles', () => {
  it('ships built-in bundles whose entries resolve against the real registry', () => {
    const real = MarketplaceRegistry.fromFile(
      join(__dirname, '..', 'registry', 'registry.json'),
    );
    for (const bundle of listBundles()) {
      const { missing } = resolveBundle(bundle, real);
      expect(missing, `bundle ${bundle.id}`).toEqual([]);
    }
  });

  it('installs a bundle, installing MCP entries disabled and reporting missing ones', () => {
    const registry = MarketplaceRegistry.fromFile(registryPath);
    const installer = new MarketplaceInstaller(join(dir, 'marketplace'));
    const bundle = { id: 'test-bundle', name: 'T', description: 'd', entryIds: ['meeting-scribe', 'meeting-notes', 'postgres-local', 'nope'] };
    const result = installBundle(bundle, registry, installer);
    expect(result.installed.map((r) => r.entryId).sort()).toEqual(['meeting-notes', 'meeting-scribe']);
    // #155: bundle MCP entries are installed (disabled, checksummed), not skipped.
    expect(result.installedMcp.map((r) => r.entryId)).toEqual(['postgres-local']);
    expect(result.skippedMcp).toEqual([]);
    expect(result.missing).toEqual(['nope']);
    expect(existsSync(join(dir, 'marketplace', 'installed', 'skills', 'meeting-notes.md'))).toBe(true);
    const mcp = JSON.parse(readFileSync(join(dir, 'marketplace', 'installed', 'mcp-servers', 'postgres-local.json'), 'utf8')) as { enabled: boolean; checksum: string };
    expect(mcp.enabled).toBe(false);
    expect(typeof mcp.checksum).toBe('string');
  });
});

describe('first-run bootstrap', () => {
  it('installs getting-started exactly once and writes the marker', () => {
    const registry = MarketplaceRegistry.fromFile(registryPath);
    const installer = new MarketplaceInstaller(join(dir, 'marketplace'));
    const first = bootstrapFirstRun({ dataDir: dir, registry, installer });
    expect(first.alreadyBootstrapped).toBe(false);
    expect(first.bundle?.installed.length).toBeGreaterThan(0);
    const marker = JSON.parse(readFileSync(join(dir, 'bootstrap.json'), 'utf8')) as { bundleId: string };
    expect(marker.bundleId).toBe('getting-started');
    const second = bootstrapFirstRun({ dataDir: dir, registry, installer });
    expect(second.alreadyBootstrapped).toBe(true);
  });
});

describe('authoring scaffold', () => {
  it('writes a loader-format skill file and refuses overwrites/unsafe slugs', () => {
    const skillsDir = join(dir, 'skills');
    const path = scaffoldSkill(skillsDir, { slug: 'my-skill', name: 'My Skill', description: 'Does things.' });
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('name: my-skill');
    expect(content).toContain('description: Does things.');
    expect(content).toContain('# My Skill');
    expect(() => scaffoldSkill(skillsDir, { slug: 'my-skill', name: 'x', description: 'y' })).toThrow(/already exists/);
    expect(() => scaffoldSkill(skillsDir, { slug: '../evil', name: 'x', description: 'y' })).toThrow(/unsafe/);
  });
});

describe('registry manifest caching', () => {
  it('returns the cached instance until the file changes', () => {
    const a = MarketplaceRegistry.fromFile(registryPath);
    const b = MarketplaceRegistry.fromFile(registryPath);
    expect(a).toBe(b);
    const entries = [entry('skill', 'meeting-notes'), entry('skill', 'git-hygiene'), entry('skill', 'cron-scheduling'), entry('bot', 'meeting-scribe'), entry('skill', 'brand-new')];
    writeFileSync(registryPath, JSON.stringify({ entries }));
    const c = MarketplaceRegistry.fromFile(registryPath);
    expect(c).not.toBe(a);
    expect(c.getById('brand-new')).toBeDefined();
  });
});
