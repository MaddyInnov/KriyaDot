// SPDX-License-Identifier: Apache-2.0
// Octomind closure rows for @mvp/marketplace: #155, #156, #157, #158,
// #159, #165, #103/#153/#171. No network: fetchers and dependency
// installers are injected fakes throughout.

import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootstrapFirstRun,
  buildBootstrapPlan,
  clearMarketplaceRegistryCache,
  createPortableManifest,
  filterTools,
  findBundleByPackageName,
  installBundle,
  installFromLocalTap,
  installFromTap,
  installPortableManifest,
  isToolAllowed,
  loadTapChannels,
  MarketplaceInstaller,
  MarketplaceRegistry,
  packageNameOf,
  parseGitHubRepoRef,
  parsePackageName,
  parsePortableManifest,
  publishSpecialistToFile,
  registerPackage,
  resolveBundle,
  resolveGitHubManifestUrl,
  resolvePackageName,
  resolveTapSource,
  saveTapChannel,
  scaffoldPackage,
  substitutePlaceholders,
  UnresolvedPlaceholdersError,
  validatePackage,
} from '../src/index.js';
import type { MarketplaceEntry, SkillBundle } from '../src/index.js';

let dir: string;

function botEntry(id: string, extra: Record<string, unknown> = {}): MarketplaceEntry {
  return {
    id, kind: 'bot', name: id, version: '1.0.0', creator: 'test', description: `${id} desc`,
    license: 'Apache-2.0', priceCents: 0, tags: [], untrusted: false,
    payload: { id, name: id, description: 'bot', systemPrompt: 'You are a bot.', provider: 'groq', model: 'm1', skills: [], tools: [], mcpServers: [] },
    ...extra,
  } as MarketplaceEntry;
}
function skillEntry(id: string): MarketplaceEntry {
  return {
    id, kind: 'skill', name: id, version: '1.0.0', creator: 'test', description: `${id} desc`,
    license: 'Apache-2.0', priceCents: 0, tags: [], untrusted: false,
    payload: { id, content: `# ${id}\n` },
  } as MarketplaceEntry;
}
function workflowEntry(id: string): MarketplaceEntry {
  return {
    id, kind: 'workflow', name: id, version: '1.0.0', creator: 'test', description: `${id} desc`,
    license: 'Apache-2.0', priceCents: 0, tags: [], untrusted: false,
    payload: { id, name: id, description: 'wf', nodes: [{ id: 't', type: 'trigger', name: 'Start', config: {} }], edges: [] },
  } as MarketplaceEntry;
}
function mcpEntry(id: string, requiredEnv: string[] = []): MarketplaceEntry {
  return {
    id, kind: 'mcp-server', name: id, version: '1.0.0', creator: 'test', description: `${id} desc`,
    license: 'MIT', priceCents: 0, tags: [], untrusted: true,
    payload: { id, label: id, command: 'npx', args: ['-y', 'srv'], requiredEnv, description: 'mcp' },
  } as MarketplaceEntry;
}
function capabilityEntry(): MarketplaceEntry {
  return {
    id: 'fs-cap', kind: 'capability', name: 'FS Capability', version: '1.0.0', creator: 'test',
    description: 'Filesystem capability', license: 'Apache-2.0', priceCents: 0, tags: [], untrusted: false,
    payload: {
      id: 'fs-cap', name: 'FS Capability', description: 'Filesystem capability',
      mcpServers: [{ id: 'fs-mcp', label: 'FS MCP', command: 'npx', args: ['-y', 'fs-srv'], requiredEnv: ['FS_ROOT'], description: 'fs' }],
      toolFilters: { allow: ['fs_*', 'read_file'], deny: ['fs_delete*'] },
      requiredEnv: ['FS_ROOT'], dependencies: [],
    },
  } as MarketplaceEntry;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-closure-'));
  clearMarketplaceRegistryCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearMarketplaceRegistryCache();
});

describe('#155 category:variant naming + package resolution', () => {
  it('parses and formats package names, finds bundles by them', () => {
    expect(parsePackageName('dev:toolkit')).toEqual({ category: 'dev', variant: 'toolkit' });
    expect(parsePackageName('no-colon')).toBeNull();
    expect(parsePackageName('a:b:c')).toBeNull();
    const bundle = findBundleByPackageName('dev:toolkit')!;
    expect(bundle.id).toBe('developer-toolkit');
    expect(packageNameOf(bundle)).toBe('dev:toolkit');
    expect(findBundleByPackageName('developer-toolkit')?.id).toBe('developer-toolkit');
  });

  it('resolves entries by package name in the registry', () => {
    const reg = MarketplaceRegistry.fromEntries([botEntry('spec-bot', { category: 'research', variant: 'deep' })]);
    expect(reg.getByPackageName('research:deep')?.id).toBe('spec-bot');
    expect(reg.getByPackageName('research:shallow')).toBeUndefined();
  });

  it('resolvePackageName maps a package name to installed bots (run-by-name API)', () => {
    const registryPath = join(dir, 'registry.json');
    writeFileSync(registryPath, JSON.stringify({
      entries: [botEntry('meeting-scribe'), skillEntry('meeting-notes'), skillEntry('git-hygiene'), skillEntry('cron-scheduling')],
    }));
    const registry = MarketplaceRegistry.fromFile(registryPath);
    const installer = new MarketplaceInstaller(join(dir, 'mkt'));
    const before = resolvePackageName('starter:essentials', { registry, installer });
    expect(before.bundle?.id).toBe('getting-started');
    expect(before.installed).toBe(false);
    installBundle(before.bundle!, registry, installer);
    const after = resolvePackageName('starter:essentials', { registry, installer });
    expect(after.installed).toBe(true);
    expect(after.packageName).toBe('starter:essentials');
    expect(after.installedBotPaths[0]).toContain('meeting-scribe.json');
  });

  it('installs inline bundle-manifest MCP servers, retaining them in resolution', () => {
    const registry = MarketplaceRegistry.fromEntries([botEntry('b1')]);
    const installer = new MarketplaceInstaller(join(dir, 'mkt'));
    const bundle: SkillBundle = {
      id: 'inline-b', name: 'Inline', description: 'd', entryIds: ['b1'],
      mcpServers: [{ id: 'inline-mcp', label: 'Inline MCP', command: 'node', args: ['srv.js'], requiredEnv: [], description: 'inline' }],
    };
    expect(resolveBundle(bundle, registry).mcpServers.map((s) => s.id)).toEqual(['inline-mcp']);
    const result = installBundle(bundle, registry, installer);
    expect(result.installedMcp.map((r) => r.entryId)).toEqual(['inline-mcp']);
    const written = installer.readInstalledMcp('inline-mcp')!;
    expect(written.enabled).toBe(false);
    expect(written.installedVia).toBe('bundle');
    expect(typeof written.checksum).toBe('string');
  });
});

describe('#156 first-use bootstrap: deps, credentials, MCP plan', () => {
  it('installs declared dependencies via the injected hook (no network)', () => {
    const registry = MarketplaceRegistry.fromEntries([botEntry('b1')]);
    const installer = new MarketplaceInstaller(join(dir, 'mkt'));
    const calls: string[] = [];
    const bundle: SkillBundle = { id: 'dep-b', name: 'D', description: 'd', entryIds: ['b1'], dependencies: ['pkg-a@1.0.0', 'pkg-b'] };
    const result = installBundle(bundle, registry, installer, {
      depInstaller: (dep) => { calls.push(dep); return { dependency: dep, status: 'installed' }; },
    });
    expect(calls).toEqual(['pkg-a@1.0.0', 'pkg-b']);
    expect(result.dependencies.map((d) => d.status)).toEqual(['installed', 'installed']);
  });

  it('reports missing credentials as explicit blockers, resolved ones pass', () => {
    const registry = MarketplaceRegistry.fromEntries([botEntry('b1'), mcpEntry('db-mcp', ['DB_URL'])]);
    const installer = new MarketplaceInstaller(join(dir, 'mkt'));
    const bundle: SkillBundle = { id: 'cred-b', name: 'C', description: 'd', entryIds: ['b1', 'db-mcp'], requiredEnv: ['EXTRA_KEY'] };
    const missing = installBundle(bundle, registry, installer, { env: {} });
    expect(missing.credentialBlockers.sort()).toEqual(['missing-env:DB_URL', 'missing-env:EXTRA_KEY']);
    expect(missing.blockers).toContain('missing-env:DB_URL');
    const ok = installBundle(bundle, registry, installer, { env: { DB_URL: 'postgres://x', EXTRA_KEY: 'k' }, overwrite: true });
    expect(ok.credentialBlockers).toEqual([]);
    expect(ok.mcpPlan.find((s) => s.id === 'db-mcp')?.env).toEqual({ DB_URL: 'postgres://x' });
    expect(ok.mcpPlan[0].checksum).toHaveLength(64);
  });

  it('buildBootstrapPlan surfaces blockers before install', () => {
    const registry = MarketplaceRegistry.fromEntries([mcpEntry('db-mcp', ['DB_URL'])]);
    const bundle: SkillBundle = { id: 'p', name: 'P', description: 'd', entryIds: ['db-mcp'], dependencies: ['pkg-a'] };
    const plan = buildBootstrapPlan(bundle, registry, {});
    expect(plan.blockers).toEqual(['missing-env:DB_URL']);
    expect(plan.dependencies).toEqual(['pkg-a']);
    expect(plan.mcpServers.map((s) => s.id)).toEqual(['db-mcp']);
  });

  it('bootstrapFirstRun returns the plan and stays idempotent at startup', () => {
    const registryPath = join(dir, 'registry.json');
    writeFileSync(registryPath, JSON.stringify({
      entries: [botEntry('meeting-scribe'), skillEntry('meeting-notes'), skillEntry('git-hygiene'), skillEntry('cron-scheduling')],
    }));
    const registry = MarketplaceRegistry.fromFile(registryPath);
    const installer = new MarketplaceInstaller(join(dir, 'mkt'));
    const first = bootstrapFirstRun({ dataDir: dir, registry, installer, depInstaller: (d) => ({ dependency: d, status: 'recorded' }) });
    expect(first.alreadyBootstrapped).toBe(false);
    expect(first.plan?.bundleId).toBe('getting-started');
    expect(first.plan?.packageName).toBe('starter:essentials');
    const second = bootstrapFirstRun({ dataDir: dir, registry, installer });
    expect(second.alreadyBootstrapped).toBe(true);
    const third = bootstrapFirstRun({ dataDir: dir, registry, installer });
    expect(third.alreadyBootstrapped).toBe(true);
  });
});

describe('#158 placeholders + overrides', () => {
  it('substitutes {{env:}} and {{config:}} placeholders', () => {
    const { value, unresolved } = substitutePlaceholders(
      { prompt: 'key={{env:MY_KEY}} region={{config:region}}' },
      { env: { MY_KEY: 'secret' }, config: { region: 'eu' } },
    );
    expect(value.prompt).toBe('key=secret region=eu');
    expect(unresolved).toEqual([]);
    const wf = substitutePlaceholders({ prompt: 'hi {{input}} {{nodes.a.output}}' }, {});
    expect(wf.unresolved).toEqual([]);
  });

  it('installer substitutes at install time and fails loudly when unresolved', () => {
    const installer = new MarketplaceInstaller(join(dir, 'mkt'));
    const entry = botEntry('ph-bot');
    (entry.payload as { systemPrompt: string }).systemPrompt = 'Use {{env:MY_KEY}} in {{config:region}}';
    const res = installer.install(entry, { values: { env: { MY_KEY: 'k1' }, config: { region: 'eu' } } });
    const written = JSON.parse(readFileSync(res.installedPath, 'utf8')) as { systemPrompt: string };
    expect(written.systemPrompt).toBe('Use k1 in eu');
    const entry2 = botEntry('ph-bot-3');
    (entry2.payload as { systemPrompt: string }).systemPrompt = 'Needs {{env:NOPE}}';
    expect(() => installer.install(entry2)).toThrow(UnresolvedPlaceholdersError);
    try { installer.install(entry2); } catch (err) {
      expect((err as UnresolvedPlaceholdersError).unresolved).toEqual(['env:NOPE']);
    }
  });

  it('applies per-capability overrides: model, enabled, config', () => {
    const installer = new MarketplaceInstaller(join(dir, 'mkt'));
    const res = installer.install(botEntry('ov-bot'), {
      overrides: { 'ov-bot': { model: 'better-model', enabled: false, config: { temperature: 0.2 } } },
    });
    expect(res.overrideApplied).toBe(true);
    expect(res.enabled).toBe(false);
    const written = JSON.parse(readFileSync(res.installedPath, 'utf8')) as { model: string; enabled: boolean; config: { temperature: number } };
    expect(written.model).toBe('better-model');
    expect(written.enabled).toBe(false);
    expect(written.config.temperature).toBe(0.2);
  });

  it('bundle installs report unresolved placeholders as blockers instead of aborting', () => {
    const entry = botEntry('blk-bot');
    (entry.payload as { systemPrompt: string }).systemPrompt = 'Needs {{env:MISSING_X}}';
    const registry = MarketplaceRegistry.fromEntries([entry]);
    const installer = new MarketplaceInstaller(join(dir, 'mkt'));
    const result = installBundle({ id: 'blk-b', name: 'B', description: 'd', entryIds: ['blk-bot'] }, registry, installer);
    expect(result.blockers.some((b) => b.includes('unresolved-placeholder:env:MISSING_X'))).toBe(true);
  });
});

describe('#159 configurable manifest-cache freshness', () => {
  it('revalidates after the freshness TTL even when mtime/size are unchanged', () => {
    const path = join(dir, 'reg.json');
    const fixedTime = new Date(1_700_000_000_000); // whole-second: exact mtimeMs round-trip
    const write = (id: string) => {
      writeFileSync(path, JSON.stringify({ entries: [skillEntry(id)] }));
      utimesSync(path, fixedTime, fixedTime);
    };
    write('aaa-skill');
    let now = 1_000;
    const clock = () => now;
    const a = MarketplaceRegistry.fromFile(path, { freshnessMs: 5_000, now: clock });
    write('bbb-skill');
    now = 3_000; // within TTL: cached (stale by design until expiry)
    const b = MarketplaceRegistry.fromFile(path, { freshnessMs: 5_000, now: clock });
    expect(b).toBe(a);
    expect(b.getById('bbb-skill')).toBeUndefined();
    now = 9_000; // past TTL: revalidate from disk
    const c = MarketplaceRegistry.fromFile(path, { freshnessMs: 5_000, now: clock });
    expect(c).not.toBe(a);
    expect(c.getById('bbb-skill')).toBeDefined();
  });
});

describe('#165 capability bundles', () => {
  it('installs as one unit: MCP configs + tool filters + checksum', () => {
    const registry = MarketplaceRegistry.fromEntries([capabilityEntry()]);
    expect(registry.list({ kind: 'capability' }).map((e) => e.id)).toEqual(['fs-cap']);
    const installer = new MarketplaceInstaller(join(dir, 'mkt'));
    const res = installer.install(capabilityEntry());
    expect(res.kind).toBe('capability');
    const written = JSON.parse(readFileSync(res.installedPath, 'utf8')) as {
      toolFilters: { allow: string[]; deny: string[] };
      mcpServers: Array<{ id: string; enabled: boolean; env: Record<string, null> }>;
      checksum: string;
    };
    expect(written.toolFilters).toEqual({ allow: ['fs_*', 'read_file'], deny: ['fs_delete*'] });
    expect(written.mcpServers[0]).toMatchObject({ id: 'fs-mcp', enabled: false, env: { FS_ROOT: null } });
    expect(written.checksum).toHaveLength(64);
    expect(installer.uninstall('capabilities', 'fs-cap')).toBe(true);
  });

  it('tool filters: deny wins, wildcards match, empty allow = allow all', () => {
    const filters = { allow: ['fs_*', 'read_file'], deny: ['fs_delete*'] };
    expect(isToolAllowed('fs_read', filters)).toBe(true);
    expect(isToolAllowed('fs_delete_file', filters)).toBe(false);
    expect(isToolAllowed('web_search', filters)).toBe(false);
    expect(isToolAllowed('anything', { allow: [], deny: [] })).toBe(true);
    expect(filterTools(['fs_read', 'fs_delete_x', 'read_file', 'nope'], filters)).toEqual(['fs_read', 'read_file']);
  });
});

describe('#157 tap init scaffolding', () => {
  it('scaffolds bot/workflow packages, validates, and registers into the local registry', () => {
    const pkgRoot = join(dir, 'pkgs');
    const bot = scaffoldPackage(pkgRoot, { kind: 'bot', id: 'my-bot', name: 'My Bot', description: 'Does bot things.', category: 'dev', variant: 'mine' });
    expect(existsSync(bot.manifestPath)).toBe(true);
    expect(bot.entry?.kind).toBe('bot');
    expect(validatePackage(bot.dir)).toEqual({ valid: true, errors: [], kind: 'bot', id: 'my-bot' });
    const wf = scaffoldPackage(pkgRoot, { kind: 'workflow', id: 'my-flow', name: 'My Flow', description: 'Flows.' });
    expect(validatePackage(wf.dir).valid).toBe(true);
    expect(() => scaffoldPackage(pkgRoot, { kind: 'bot', id: 'my-bot', name: 'x', description: 'y' })).toThrow(/already exists/);
    expect(() => scaffoldPackage(pkgRoot, { kind: 'bot', id: '../evil', name: 'x', description: 'y' })).toThrow(/unsafe/);

    const registryPath = join(dir, 'reg', 'registry.json');
    mkdirSync(join(dir, 'reg'), { recursive: true });
    writeFileSync(registryPath, JSON.stringify({ entries: [] }));
    expect(registerPackage(bot.dir, registryPath)).toEqual({ registered: 'registry', id: 'my-bot' });
    const reg = MarketplaceRegistry.fromFile(registryPath);
    expect(reg.getById('my-bot')?.kind).toBe('bot');
    expect(reg.getByPackageName('dev:mine')?.id).toBe('my-bot');
  });

  it('scaffolds a tap and registers it as a named channel; invalid packages fail validation', () => {
    const tap = scaffoldPackage(join(dir, 'taps'), { kind: 'tap', id: 'my-tap', name: 'My Tap', description: 'A tap.' });
    expect(validatePackage(tap.dir)).toMatchObject({ valid: true, kind: 'tap' });
    const registryPath = join(dir, 'reg2', 'registry.json');
    const channelsPath = join(dir, 'reg2', 'taps.json');
    expect(registerPackage(tap.dir, registryPath, channelsPath)).toEqual({ registered: 'tap-channel', id: 'my-tap' });
    expect(loadTapChannels(channelsPath)['my-tap']).toEqual({ type: 'local', path: tap.dir });
    const empty = join(dir, 'empty-pkg');
    mkdirSync(empty, { recursive: true });
    expect(validatePackage(empty).valid).toBe(false);
    expect(() => registerPackage(empty, registryPath, channelsPath)).toThrow(/invalid package/);
  });
});

describe('#103/#153 tap distribution', () => {
  it('parses GitHub refs and resolves raw manifest URLs', () => {
    expect(parseGitHubRepoRef('acme/taps')).toMatchObject({ owner: 'acme', repo: 'taps', branch: 'main' });
    expect(parseGitHubRepoRef('acme/taps@dev').branch).toBe('dev');
    expect(parseGitHubRepoRef('https://github.com/acme/taps/tree/v2')).toMatchObject({ owner: 'acme', repo: 'taps', branch: 'v2' });
    expect(resolveGitHubManifestUrl('acme/taps')).toBe('https://raw.githubusercontent.com/acme/taps/main/marketplace.json');
    expect(() => parseGitHubRepoRef('just-a-name')).toThrow(/owner\/repo/);
  });

  it('installs workflows + capabilities from a GitHub tap via a fake fetcher (no network)', async () => {
    const seen: string[] = [];
    const fetcher = async (url: string) => {
      seen.push(url);
      return JSON.stringify({ name: 'acme', entries: [workflowEntry('tap-flow'), capabilityEntry(), mcpEntry('tap-mcp')] });
    };
    const installer = new MarketplaceInstaller(join(dir, 'mkt'));
    const report = await installFromTap({ type: 'github', repo: 'acme/taps' }, { fetcher, installer });
    expect(seen).toEqual(['https://raw.githubusercontent.com/acme/taps/main/marketplace.json']);
    expect(report.installed.map((r) => r.entryId).sort()).toEqual(['fs-cap', 'tap-flow']);
    expect(report.installedMcp.map((r) => r.entryId)).toEqual(['fs-mcp']);
    expect(report.gatedMcp).toEqual(['tap-mcp']);
    expect(existsSync(join(dir, 'mkt', 'installed', 'workflows', 'tap-flow.json'))).toBe(true);
  });

  it('installs from a local tap directory', () => {
    const tapDir = join(dir, 'local-tap');
    mkdirSync(tapDir, { recursive: true });
    writeFileSync(join(tapDir, 'tap.json'), JSON.stringify({ name: 'local', entries: [skillEntry('tap-skill')] }));
    const installer = new MarketplaceInstaller(join(dir, 'mkt'));
    const report = installFromLocalTap(tapDir, installer);
    expect(report.installed.map((r) => r.entryId)).toEqual(['tap-skill']);
  });

  it('installs through a named tap channel', async () => {
    const tapDir = join(dir, 'chan-tap');
    mkdirSync(tapDir, { recursive: true });
    writeFileSync(join(tapDir, 'tap.json'), JSON.stringify({ entries: [skillEntry('chan-skill')] }));
    const channelsPath = join(dir, 'taps.json');
    saveTapChannel(channelsPath, 'my-chan', { type: 'local', path: tapDir });
    expect(resolveTapSource('channel:my-chan', channelsPath)).toEqual({ type: 'local', path: tapDir });
    const installer = new MarketplaceInstaller(join(dir, 'mkt'));
    const report = await installFromTap(
      { type: 'channel', name: 'my-chan' },
      { fetcher: async () => { throw new Error('network must not be used for local channels'); }, installer, channelsPath },
    );
    expect(report.installed.map((r) => r.entryId)).toEqual(['chan-skill']);
  });
});

describe('#171 portable specialist publishing (round-trip)', () => {
  it('publishes an entry to a file and installs it elsewhere', () => {
    const file = join(dir, 'published', 'spec.json');
    const manifest = publishSpecialistToFile({ entry: botEntry('portable-bot') }, file);
    expect(manifest.format).toBe('kriyadot-portable@1');
    const parsed = parsePortableManifest(readFileSync(file, 'utf8'));
    const installer = new MarketplaceInstaller(join(dir, 'elsewhere'));
    const result = installPortableManifest(parsed, installer);
    expect(result.installed.map((r) => r.entryId)).toEqual(['portable-bot']);
    expect(existsSync(join(dir, 'elsewhere', 'installed', 'bots', 'portable-bot.json'))).toBe(true);
  });

  it('round-trips a bundle and rejects tampered manifests', () => {
    const entries = [botEntry('pb-bot'), skillEntry('pb-skill')];
    const bundle: SkillBundle = { id: 'pb', name: 'PB', description: 'd', entryIds: ['pb-bot', 'pb-skill'], category: 'x', variant: 'y' };
    const text = JSON.stringify(createPortableManifest({ bundle, entries }));
    const installer = new MarketplaceInstaller(join(dir, 'elsewhere2'));
    const result = installPortableManifest(text, installer);
    expect(result.bundle?.packageName).toBe('x:y');
    expect(existsSync(join(dir, 'elsewhere2', 'installed', 'bots', 'pb-bot.json'))).toBe(true);
    const tampered = text.replace('pb-bot', 'pb-BOT');
    expect(() => parsePortableManifest(tampered)).toThrow(/checksum/);
  });
});
