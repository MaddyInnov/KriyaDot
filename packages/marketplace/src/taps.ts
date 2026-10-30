// SPDX-License-Identifier: Apache-2.0
/**
 * Taps, package scaffolding, and portable publishing.
 *
 * TAP DISTRIBUTION (#103/#153/#171): bundles, workflows, and capability
 * bundles (any registry entry, in fact) can be installed from:
 *   (a) a GitHub repo reference — `owner/repo`, `owner/repo@branch`, or
 *       a github.com URL — resolved to a raw manifest URL through an
 *       INJECTABLE fetcher (tests use fakes; no network in tests);
 *   (b) a local tap directory containing a tap/registry JSON index;
 *   (c) a named tap channel — a named index source persisted in a
 *       channels file (`taps.json`) next to the registry.
 * A "tap" is a named index source listing packages: its index document
 * is `{ name?, entries: MarketplaceEntry[] }`.
 *
 * TAP AUTHORING (#157): scaffoldPackage() is the `tap init` logic —
 * it scaffolds a package (bot / workflow / capability / skill / tap)
 * into a target dir with a valid manifest, validatePackage() checks a
 * scaffolded (or any) package dir, and registerPackage() registers it
 * into the local registry (entries) or the tap-channel store (taps).
 * The CLI surface that calls these lives in another workstream.
 *
 * PORTABLE SPECIALIST PUBLISHING (#171): export an installed/local
 * specialist (a single entry, or a bundle + its entries) as a portable
 * manifest file with a SHA-256 checksum; anyone can install it
 * elsewhere with installPortableManifest() (round-trip tested).
 *
 * HOST WIRING (parent/API side): expose taps via routes that call
 * installFromTap()/installFromLocalTap() with a real fetcher
 * (global fetch) for GitHub sources; wire `kriyadot tap init` in the
 * CLI package to scaffoldPackage/validatePackage/registerPackage.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  appendEntryToRegistryFile,
  isMarketplaceEntry,
  MarketplaceRegistry,
  parseMarketplaceEntries,
} from './registry.js';
import type { MarketplaceEntry } from './registry.js';
import { installBundle } from './bundles.js';
import type { SkillBundle } from './bundles.js';
import type { InstallResult, MarketplaceInstaller } from './installer.js';

// ---------------------------------------------------------------------------
// Tap sources
// ---------------------------------------------------------------------------

export type TapSource =
  | { type: 'github'; repo: string; branch?: string; manifestPath?: string }
  | { type: 'local'; path: string }
  | { type: 'channel'; name: string };

/** Injectable fetcher: URL → response body text. Tests pass fakes. */
export type TapFetcher = (url: string) => Promise<string>;

export interface ParsedGitHubRef {
  owner: string;
  repo: string;
  branch: string;
  /** Raw content base, e.g. https://raw.githubusercontent.com/owner/repo/main */
  rawBaseUrl: string;
}

/** Parse `owner/repo`, `owner/repo@branch`, or a github.com URL (incl. /tree/<branch>). */
export function parseGitHubRepoRef(ref: string): ParsedGitHubRef {
  let owner = '';
  let repo = '';
  let branch = 'main';
  const trimmed = ref.trim();
  const urlMatch = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+))?\/?$/.exec(trimmed);
  if (urlMatch) {
    owner = urlMatch[1];
    repo = urlMatch[2];
    if (urlMatch[3]) branch = urlMatch[3];
  } else {
    const atSplit = trimmed.split('@');
    const slug = atSplit[0];
    if (atSplit[1]) branch = atSplit[1];
    const parts = slug.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`invalid GitHub repo reference "${ref}" (expected owner/repo)`);
    }
    [owner, repo] = parts;
    repo = repo.replace(/\.git$/, '');
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`invalid GitHub repo reference "${ref}"`);
  }
  return { owner, repo, branch, rawBaseUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}` };
}

/** Resolve a GitHub tap ref + manifest path to the raw manifest URL. */
export function resolveGitHubManifestUrl(ref: string, manifestPath = 'marketplace.json'): string {
  const parsed = parseGitHubRepoRef(ref);
  return `${parsed.rawBaseUrl}/${manifestPath.replace(/^\//, '')}`;
}

// ---------------------------------------------------------------------------
// Tap channels (named index sources)
// ---------------------------------------------------------------------------

export type StoredTapSource = Exclude<TapSource, { type: 'channel' }>;

/** Load the named-channel store (`{ channels: { name: source } }`); missing file = empty. */
export function loadTapChannels(channelsPath: string): Record<string, StoredTapSource> {
  try {
    const parsed = JSON.parse(readFileSync(channelsPath, 'utf8')) as { channels?: Record<string, StoredTapSource> };
    return parsed.channels ?? {};
  } catch {
    return {};
  }
}

export function saveTapChannel(channelsPath: string, name: string, source: StoredTapSource): void {
  const channels = loadTapChannels(channelsPath);
  channels[name] = source;
  mkdirSync(join(channelsPath, '..'), { recursive: true });
  writeFileSync(channelsPath, JSON.stringify({ channels }, null, 2) + '\n', 'utf8');
}

/**
 * Resolve any tap reference string to a concrete source:
 * `channel:<name>` (needs channelsPath), `local:<path>`, `github:<ref>`,
 * a bare `owner/repo`, a github.com URL, or an existing directory path.
 */
export function resolveTapSource(ref: string, channelsPath?: string): TapSource {
  const trimmed = ref.trim();
  if (trimmed.startsWith('channel:')) {
    const name = trimmed.slice('channel:'.length);
    if (!channelsPath) throw new Error('channel tap requires a channels file path');
    const source = loadTapChannels(channelsPath)[name];
    if (!source) throw new Error(`unknown tap channel "${name}"`);
    return source;
  }
  if (trimmed.startsWith('local:')) return { type: 'local', path: trimmed.slice('local:'.length) };
  if (trimmed.startsWith('github:')) return { type: 'github', repo: trimmed.slice('github:'.length) };
  if (/^https?:\/\/github\.com\//.test(trimmed) || /^[\w.-]+\/[\w.-]+(@[\w./-]+)?$/.test(trimmed)) {
    return { type: 'github', repo: trimmed };
  }
  return { type: 'local', path: trimmed };
}

// ---------------------------------------------------------------------------
// Tap index loading + installation
// ---------------------------------------------------------------------------

export interface TapIndex {
  name?: string;
  entries: MarketplaceEntry[];
}

/** Parse a tap index document (`{ entries: [...] }`, optionally named). */
export function parseTapIndex(jsonText: string): TapIndex {
  const parsed = JSON.parse(jsonText) as { name?: unknown; entries?: unknown; packages?: unknown };
  const list = Array.isArray(parsed.entries) ? parsed.entries : Array.isArray(parsed.packages) ? parsed.packages : null;
  if (!list) throw new Error('tap index: expected an "entries" array');
  return { name: typeof parsed.name === 'string' ? parsed.name : undefined, entries: parseMarketplaceEntries(list) };
}

/** Read a local tap directory's index (tap.json, registry.json, or marketplace.json). */
export function loadLocalTap(dir: string): TapIndex {
  for (const file of ['tap.json', 'registry.json', 'marketplace.json']) {
    const path = join(dir, file);
    if (existsSync(path)) return parseTapIndex(readFileSync(path, 'utf8'));
  }
  throw new Error(`local tap "${dir}" has no tap.json / registry.json / marketplace.json index`);
}

export interface TapInstallOptions {
  overwrite?: boolean;
  /** Token provider for standalone mcp-server entries; without one they are reported gated. */
  mcpApprovalTokenFor?: (entryId: string) => string | undefined;
  env?: Record<string, string | undefined>;
}

export interface TapInstallReport {
  source: string;
  installed: InstallResult[];
  /** Bundle/capability MCP servers installed disabled (#155 semantics). */
  installedMcp: InstallResult[];
  /** Standalone MCP entries that still need the approval flow. */
  gatedMcp: string[];
  errors: string[];
}

/** Install a set of tap entries through the installer (shared core). */
export function installTapEntries(
  entries: MarketplaceEntry[],
  installer: MarketplaceInstaller,
  opts: TapInstallOptions & { source: string },
): TapInstallReport {
  const report: TapInstallReport = { source: opts.source, installed: [], installedMcp: [], gatedMcp: [], errors: [] };
  const registry = MarketplaceRegistry.fromEntries(entries);
  for (const entry of entries) {
    try {
      if (entry.kind === 'mcp-server') {
        const token = opts.mcpApprovalTokenFor?.(entry.id);
        if (token) {
          report.installed.push(installer.install(entry, { mcpApprovalToken: token, overwrite: opts.overwrite }));
        } else {
          report.gatedMcp.push(entry.id);
        }
        continue;
      }
      const result = installer.install(entry, { overwrite: opts.overwrite });
      report.installed.push(result);
      // Capability bundles also register their MCP servers disabled.
      if (entry.kind === 'capability') {
        const payload = entry.payload as { mcpServers: Parameters<MarketplaceInstaller['installMcpServerForBundle']>[0][] };
        for (const s of payload.mcpServers) {
          report.installedMcp.push(installer.installMcpServerForBundle(s, { sourceId: entry.id, env: opts.env, overwrite: opts.overwrite }));
        }
      }
    } catch (err) {
      report.errors.push(`${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  void registry;
  return report;
}

/** Install a bundle shipped by a tap (entries + bundle definition) as one unit. */
export function installTapBundle(
  bundle: SkillBundle,
  entries: MarketplaceEntry[],
  installer: MarketplaceInstaller,
): { bundle: ReturnType<typeof installBundle> } {
  const registry = MarketplaceRegistry.fromEntries(entries);
  return { bundle: installBundle(bundle, registry, installer) };
}

/** Fetch + install from a GitHub or channel tap via the injectable fetcher. NO network in tests. */
export async function installFromTap(
  source: TapSource,
  deps: { fetcher: TapFetcher; installer: MarketplaceInstaller; channelsPath?: string } & TapInstallOptions,
): Promise<TapInstallReport> {
  const concrete = source.type === 'channel' ? resolveTapSource(`channel:${source.name}`, deps.channelsPath) : source;
  if (concrete.type === 'channel') throw new Error(`tap channel "${source.type === 'channel' ? source.name : ''}" did not resolve to a concrete source`);
  if (concrete.type === 'local') return installFromLocalTap(concrete.path, deps.installer, deps);
  const url = resolveGitHubManifestUrl(concrete.repo, concrete.manifestPath ?? 'marketplace.json');
  const text = await deps.fetcher(url);
  const index = parseTapIndex(text);
  return installTapEntries(index.entries, deps.installer, { ...deps, source: `github:${concrete.repo}` });
}

/** Install from a local tap directory. */
export function installFromLocalTap(
  dir: string,
  installer: MarketplaceInstaller,
  opts: TapInstallOptions = {},
): TapInstallReport {
  const index = loadLocalTap(dir);
  return installTapEntries(index.entries, installer, { ...opts, source: `local:${dir}` });
}

// ---------------------------------------------------------------------------
// Package scaffolding — `tap init` logic (#157)
// ---------------------------------------------------------------------------

export type ScaffoldKind = 'bot' | 'workflow' | 'capability' | 'skill' | 'tap';

const SAFE_ID = /^[a-z0-9][a-z0-9-_]{0,63}$/;

export interface ScaffoldPackageInput {
  kind: ScaffoldKind;
  id: string;
  name: string;
  description: string;
  creator?: string;
  category?: string;
  variant?: string;
}

export interface ScaffoldPackageResult {
  dir: string;
  manifestPath: string;
  /** The scaffolded entry (undefined for kind 'tap', whose manifest is an index). */
  entry?: MarketplaceEntry;
}

function scaffoldEntry(input: ScaffoldPackageInput): MarketplaceEntry {
  const base = {
    id: input.id,
    name: input.name,
    version: '0.1.0',
    creator: input.creator ?? 'local',
    description: input.description,
    license: 'Apache-2.0',
    priceCents: 0,
    tags: [] as string[],
    untrusted: false,
    ...(input.category ? { category: input.category } : {}),
    ...(input.variant ? { variant: input.variant } : {}),
  };
  switch (input.kind) {
    case 'bot':
      return {
        ...base, kind: 'bot',
        payload: {
          id: input.id, name: input.name, description: input.description,
          systemPrompt: `You are ${input.name}. TODO: describe the specialist's behavior.`,
          provider: 'groq', model: 'gpt-oss-20b', skills: [], tools: [], mcpServers: [],
        },
      };
    case 'workflow':
      return {
        ...base, kind: 'workflow',
        payload: {
          id: input.id, name: input.name, description: input.description,
          nodes: [{ id: 'trigger', type: 'trigger', name: 'Start', config: {} }],
          edges: [],
        },
      };
    case 'capability':
      return {
        ...base, kind: 'capability',
        payload: {
          id: input.id, name: input.name, description: input.description,
          mcpServers: [], toolFilters: { allow: [], deny: [] }, requiredEnv: [], dependencies: [],
        },
      };
    case 'skill':
      return {
        ...base, kind: 'skill',
        payload: {
          id: input.id,
          content: `---\nname: ${input.id}\ndescription: ${input.description}\n---\n\n# ${input.name}\n\nTODO: skill steps.\n`,
        },
      };
    default:
      throw new Error(`kind "${input.kind}" has no entry manifest`);
  }
}

/**
 * `tap init` scaffolding (#157): create `<targetDir>/<id>/` with a valid
 * manifest — `manifest.json` (a MarketplaceEntry) for bot/workflow/
 * capability/skill, or `tap.json` (an empty named index) for a tap —
 * plus a README. Refuses unsafe ids and existing dirs.
 */
export function scaffoldPackage(targetDir: string, input: ScaffoldPackageInput): ScaffoldPackageResult {
  const id = input.id.trim();
  if (!SAFE_ID.test(id)) throw new Error(`unsafe package id "${input.id}" (lowercase letters, digits, - and _ only)`);
  if (!input.name.trim() || !input.description.trim()) throw new Error('package name and description are required');
  const dir = resolve(targetDir, id);
  const root = resolve(targetDir);
  if (!dir.startsWith(root + sep)) throw new Error('path traversal blocked');
  if (existsSync(dir)) throw new Error(`package "${id}" already exists at ${dir} — refusing to overwrite`);
  mkdirSync(dir, { recursive: true });

  if (input.kind === 'tap') {
    const manifestPath = join(dir, 'tap.json');
    writeFileSync(manifestPath, JSON.stringify({ name: id, entries: [] }, null, 2) + '\n', 'utf8');
    writeFileSync(join(dir, 'README.md'), `# Tap: ${input.name}\n\n${input.description}\n\nAdd entries to tap.json to publish packages through this tap.\n`, 'utf8');
    return { dir, manifestPath };
  }

  const entry = scaffoldEntry(input);
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  writeFileSync(join(dir, 'README.md'), `# ${input.name}\n\n${input.description}\n\nManifest: manifest.json (kind: ${entry.kind}). Edit the payload, then validate + register.\n`, 'utf8');
  return { dir, manifestPath, entry };
}

export interface PackageValidation {
  valid: boolean;
  errors: string[];
  kind?: string;
  id?: string;
}

/** Validate a package dir (manifest.json entry, or tap.json index). */
export function validatePackage(dir: string): PackageValidation {
  const errors: string[] = [];
  const manifestPath = join(dir, 'manifest.json');
  const tapPath = join(dir, 'tap.json');
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
      if (!isMarketplaceEntry(parsed)) {
        errors.push('manifest.json is not a valid marketplace entry');
      } else {
        return { valid: true, errors: [], kind: parsed.kind, id: parsed.id };
      }
    } catch (err) {
      errors.push(`manifest.json unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { valid: false, errors };
  }
  if (existsSync(tapPath)) {
    try {
      const index = parseTapIndex(readFileSync(tapPath, 'utf8'));
      return { valid: true, errors: [], kind: 'tap', id: index.name };
    } catch (err) {
      errors.push(`tap.json invalid: ${err instanceof Error ? err.message : String(err)}`);
      return { valid: false, errors };
    }
  }
  return { valid: false, errors: [`no manifest.json or tap.json in ${dir}`] };
}

export interface RegisterPackageResult {
  registered: 'registry' | 'tap-channel';
  id: string;
}

/**
 * Register a validated package (#157): entry packages are appended to
 * the local registry file; tap packages are registered as a named
 * local channel in the channels file next to the registry.
 */
export function registerPackage(pkgDir: string, registryPath: string, channelsPath?: string): RegisterPackageResult {
  const validation = validatePackage(pkgDir);
  if (!validation.valid) throw new Error(`cannot register invalid package: ${validation.errors.join('; ')}`);
  if (validation.kind === 'tap') {
    const channels = channelsPath ?? join(resolve(registryPath, '..'), 'taps.json');
    const name = validation.id ?? pkgDir.split(sep).pop()!;
    saveTapChannel(channels, name, { type: 'local', path: resolve(pkgDir) });
    return { registered: 'tap-channel', id: name };
  }
  const entry = JSON.parse(readFileSync(join(pkgDir, 'manifest.json'), 'utf8')) as MarketplaceEntry;
  appendEntryToRegistryFile(registryPath, entry);
  return { registered: 'registry', id: entry.id };
}

// ---------------------------------------------------------------------------
// Portable specialist publishing (#171)
// ---------------------------------------------------------------------------

export const PORTABLE_FORMAT = 'kriyadot-portable@1';

export interface PortableManifest {
  format: typeof PORTABLE_FORMAT;
  kind: 'entry' | 'bundle';
  entry?: MarketplaceEntry;
  bundle?: SkillBundle;
  entries?: MarketplaceEntry[];
  /** SHA-256 over the canonical (key-sorted) JSON of the content fields. */
  checksum: string;
  exportedAt: string;
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function portableChecksum(content: Omit<PortableManifest, 'checksum' | 'exportedAt' | 'format'>): string {
  return createHash('sha256').update(stableStringify(content)).digest('hex');
}

/** Export a single entry OR a bundle (+ its resolved entries) as a portable manifest. */
export function createPortableManifest(
  input: { entry: MarketplaceEntry } | { bundle: SkillBundle; entries: MarketplaceEntry[] },
): PortableManifest {
  const content: Omit<PortableManifest, 'checksum' | 'exportedAt' | 'format'> =
    'entry' in input
      ? { kind: 'entry', entry: input.entry }
      : { kind: 'bundle', bundle: input.bundle, entries: input.entries };
  // Validate before export so a portable file is installable by construction.
  if (content.entry) parseMarketplaceEntries([content.entry]);
  if (content.entries) parseMarketplaceEntries(content.entries);
  return {
    format: PORTABLE_FORMAT,
    ...content,
    checksum: portableChecksum(content),
    exportedAt: new Date().toISOString(),
  };
}

export function serializePortableManifest(manifest: PortableManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n';
}

/** Parse + checksum-verify a portable manifest. Throws on tampering/malformation. */
export function parsePortableManifest(jsonText: string): PortableManifest {
  const parsed = JSON.parse(jsonText) as PortableManifest;
  if (parsed.format !== PORTABLE_FORMAT) throw new Error(`portable manifest: unsupported format "${String(parsed.format)}"`);
  const content: Omit<PortableManifest, 'checksum' | 'exportedAt' | 'format'> =
    parsed.kind === 'entry'
      ? { kind: 'entry', entry: parsed.entry }
      : { kind: 'bundle', bundle: parsed.bundle, entries: parsed.entries };
  if (portableChecksum(content) !== parsed.checksum) throw new Error('portable manifest: checksum mismatch (tampered or corrupted)');
  if (parsed.entry) parseMarketplaceEntries([parsed.entry]);
  if (parsed.entries) parseMarketplaceEntries(parsed.entries);
  return parsed;
}

/** Publish a specialist to a portable manifest file others can install (#171). */
export function publishSpecialistToFile(
  input: { entry: MarketplaceEntry } | { bundle: SkillBundle; entries: MarketplaceEntry[] },
  filePath: string,
): PortableManifest {
  const manifest = createPortableManifest(input);
  mkdirSync(join(resolve(filePath), '..'), { recursive: true });
  writeFileSync(filePath, serializePortableManifest(manifest), 'utf8');
  return manifest;
}

export interface PortableInstallResult {
  installed: InstallResult[];
  bundle?: ReturnType<typeof installBundle>;
  gatedMcp: string[];
}

/**
 * Install a portable manifest elsewhere (round-trip of publish): entry
 * manifests install directly (standalone MCP entries stay gated);
 * bundle manifests install as one unit via installBundle.
 */
export function installPortableManifest(
  manifestOrJson: PortableManifest | string,
  installer: MarketplaceInstaller,
  opts: { mcpApprovalTokenFor?: (entryId: string) => string | undefined } = {},
): PortableInstallResult {
  const manifest = typeof manifestOrJson === 'string' ? parsePortableManifest(manifestOrJson) : manifestOrJson;
  if (manifest.kind === 'entry' && manifest.entry) {
    const report = installTapEntries([manifest.entry], installer, { source: 'portable', mcpApprovalTokenFor: opts.mcpApprovalTokenFor });
    return { installed: [...report.installed, ...report.installedMcp], gatedMcp: report.gatedMcp };
  }
  if (manifest.kind === 'bundle' && manifest.bundle && manifest.entries) {
    const registry = MarketplaceRegistry.fromEntries(manifest.entries);
    const bundle = installBundle(manifest.bundle, registry, installer);
    return { installed: [...bundle.installed, ...bundle.installedMcp], bundle, gatedMcp: [] };
  }
  throw new Error('portable manifest: missing entry/bundle content');
}
