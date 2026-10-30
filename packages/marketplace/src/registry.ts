// SPDX-License-Identifier: Apache-2.0
// Marketplace registry: browse/install bots, skills, workflows, and MCP
// servers from a local registry JSON. Trust model:
//   - The registry is a local curator file (bundled with the server). It is
//     NOT fetched over the network, so installs never execute remote code.
//   - Third-party entries are tagged `untrusted: true` so the UI can warn.
//   - MCP server installs are approval-gated (deny-by-default): the
//     Installer refuses to write an MCP server config without a one-time
//     approval token issued only after a governance approval is approved.

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type MarketplaceKind = 'bot' | 'skill' | 'workflow' | 'mcp-server' | 'capability';

/** Bot config payload as shipped by a marketplace bot entry. */
export interface MarketplaceBotPayload {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  provider: string;
  model: string;
  skills: string[];
  tools: string[];
  mcpServers: string[];
}

/** Skill payload: the skill markdown content itself. */
export interface MarketplaceSkillPayload {
  /** Skill slug (also the filename). */
  id: string;
  /** Full SKILL.md markdown content. */
  content: string;
}

/** Workflow definition payload. */
export interface MarketplaceWorkflowPayload {
  id: string;
  name: string;
  description: string;
  nodes: Array<{ id: string; type: string; name: string; config: Record<string, unknown> }>;
  edges: [string, string][];
}

/** MCP server payload. NEVER auto-installed: requires approval. */
export interface MarketplaceMcpPayload {
  id: string;
  /** Human-readable label shown in the approval request. */
  label: string;
  command: string;
  args: string[];
  /** Env var names the server needs (values are never shipped in the registry). */
  requiredEnv: string[];
  description: string;
}

/**
 * Capability bundle payload (#165): a named, distributable unit bundling
 * MCP servers + tool filters (allow/deny wildcard patterns) as ONE
 * installable entity. Discovery (agent-runtime) produces `capability`
 * items with this payload shape; the marketplace installs them.
 */
export interface MarketplaceCapabilityPayload {
  id: string;
  name: string;
  description: string;
  /** MCP servers bundled into the capability. */
  mcpServers: MarketplaceMcpPayload[];
  /** Wildcard tool filters: deny wins; empty allow = allow all. */
  toolFilters: { allow: string[]; deny: string[] };
  /** Env var names the bundled servers need (values never shipped). */
  requiredEnv?: string[];
  /** Declared package dependencies (installed at bootstrap, #156). */
  dependencies?: string[];
}

export type MarketplacePayload =
  | MarketplaceBotPayload
  | MarketplaceSkillPayload
  | MarketplaceWorkflowPayload
  | MarketplaceMcpPayload
  | MarketplaceCapabilityPayload;

export interface MarketplaceEntry {
  id: string;
  kind: MarketplaceKind;
  name: string;
  version: string;
  /** Creator handle; drives the revenue-share ledger. */
  creator: string;
  description: string;
  license: string;
  /** Price in USD cents. 0 = free. */
  priceCents: number;
  tags: string[];
  /** True for third-party/community entries (UI should warn). */
  untrusted: boolean;
  payload: MarketplacePayload;
  /** `category:variant` specialist addressing (#155). */
  category?: string;
  variant?: string;
  /** Declared package dependencies, installed at bootstrap (#156). */
  dependencies?: string[];
  /** Env var names this entry needs resolved at bootstrap (#156). */
  requiredEnv?: string[];
}

function isKind(v: unknown): v is MarketplaceKind {
  return v === 'bot' || v === 'skill' || v === 'workflow' || v === 'mcp-server' || v === 'capability';
}

export function isMcpPayload(v: unknown): v is MarketplaceMcpPayload {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === 'string' && p.id.length > 0 &&
    typeof p.label === 'string' &&
    typeof p.command === 'string' &&
    Array.isArray(p.args) &&
    Array.isArray(p.requiredEnv)
  );
}

function isPayload(kind: MarketplaceKind, payload: unknown): payload is MarketplacePayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.id !== 'string' || p.id.length === 0) return false;
  switch (kind) {
    case 'bot':
      return (
        typeof p.name === 'string' &&
        typeof p.description === 'string' &&
        typeof p.systemPrompt === 'string' &&
        typeof p.provider === 'string' &&
        typeof p.model === 'string' &&
        Array.isArray(p.skills) &&
        Array.isArray(p.tools) &&
        Array.isArray(p.mcpServers)
      );
    case 'skill':
      return typeof p.content === 'string' && p.content.length > 0;
    case 'workflow':
      return (
        typeof p.name === 'string' &&
        Array.isArray(p.nodes) &&
        Array.isArray(p.edges)
      );
    case 'mcp-server':
      return isMcpPayload(p);
    case 'capability':
      return (
        typeof p.name === 'string' &&
        typeof p.description === 'string' &&
        Array.isArray(p.mcpServers) &&
        (p.mcpServers as unknown[]).every(isMcpPayload) &&
        typeof p.toolFilters === 'object' && p.toolFilters !== null &&
        Array.isArray((p.toolFilters as { allow?: unknown }).allow) &&
        Array.isArray((p.toolFilters as { deny?: unknown }).deny)
      );
    default:
      return false;
  }
}

function isEntry(v: unknown): v is MarketplaceEntry {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!isKind(o.kind)) return false;
  const optionalOk =
    (o.category === undefined || typeof o.category === 'string') &&
    (o.variant === undefined || typeof o.variant === 'string') &&
    (o.dependencies === undefined || Array.isArray(o.dependencies)) &&
    (o.requiredEnv === undefined || Array.isArray(o.requiredEnv));
  return (
    optionalOk &&
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    typeof o.name === 'string' &&
    typeof o.version === 'string' &&
    typeof o.creator === 'string' &&
    typeof o.description === 'string' &&
    typeof o.license === 'string' &&
    typeof o.priceCents === 'number' &&
    o.priceCents >= 0 &&
    Array.isArray(o.tags) &&
    typeof o.untrusted === 'boolean' &&
    isPayload(o.kind, o.payload)
  );
}

/** Public validator (tap/portable-manifest imports reuse the registry rules). */
export const isMarketplaceEntry = isEntry;

/** Validate a list of raw entries; throws on the first malformed/duplicate one. */
export function parseMarketplaceEntries(list: unknown): MarketplaceEntry[] {
  if (!Array.isArray(list)) throw new Error('marketplace: entries must be an array');
  const entries: MarketplaceEntry[] = [];
  const seen = new Set<string>();
  list.forEach((item, idx) => {
    if (!isEntry(item)) throw new Error(`marketplace: malformed entry at index ${idx}`);
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) throw new Error(`marketplace: duplicate entry ${key}`);
    seen.add(key);
    entries.push(item);
  });
  return entries;
}

/** `category:variant` package name for an entry, when both parts exist (#155). */
export function entryPackageName(entry: MarketplaceEntry): string | undefined {
  return entry.category && entry.variant ? `${entry.category}:${entry.variant}` : undefined;
}

/**
 * Local curated marketplace registry. Loads from a single JSON file
 * (`{ entries: MarketplaceEntry[] }`). Malformed entries are rejected at
 * load time so a bad registry can never produce a half-valid install.
 */
/** Manifest cache: fromFile re-parses only when the file's mtime/size change,
 *  or when the configured freshness TTL has expired (#159). */
const registryFileCache = new Map<string, { sig: string; registry: MarketplaceRegistry; loadedAt: number }>();

/** Test hook: drop all cached registry manifests. */
export function clearMarketplaceRegistryCache(): void {
  registryFileCache.clear();
}

export interface RegistryFreshnessOptions {
  /**
   * Max cache age in ms (#159). When the cached manifest is older than
   * this, fromFile revalidates against disk even if mtime/size look
   * unchanged (e.g. a same-size rewrite with a restored mtime).
   * Undefined = freshness governed by mtime/size only (legacy behavior).
   */
  freshnessMs?: number;
  /** Injectable clock (tests); defaults to Date.now. */
  now?: () => number;
}

export class MarketplaceRegistry {
  private readonly entries: MarketplaceEntry[];

  private constructor(entries: MarketplaceEntry[]) {
    this.entries = entries;
  }

  static fromFile(registryPath: string, opts: RegistryFreshnessOptions = {}): MarketplaceRegistry {
    // Manifest caching (Octomind parity): hosts call fromFile on
    // request paths; re-reading + re-validating a large registry JSON
    // per call is wasted work. The (mtime, size) signature invalidates
    // the cache the moment the manifest changes on disk; the optional
    // freshnessMs TTL (#159) additionally forces revalidation once the
    // cached copy is older than the configured max-age.
    const now = opts.now ?? Date.now;
    try {
      const st = statSync(registryPath);
      const sig = `${st.mtimeMs}:${st.size}`;
      const hit = registryFileCache.get(registryPath);
      if (hit && hit.sig === sig) {
        const expired = opts.freshnessMs !== undefined && now() - hit.loadedAt > opts.freshnessMs;
        if (!expired) return hit.registry;
        // Expired: fall through and re-parse from disk.
      }
      const registry = MarketplaceRegistry.parseFile(registryPath);
      registryFileCache.set(registryPath, { sig, registry, loadedAt: now() });
      return registry;
    } catch (err) {
      // A missing/unreadable manifest keeps the historical behavior:
      // parseFile throws the descriptive error.
      if (registryFileCache.has(registryPath)) throw err;
      return MarketplaceRegistry.parseFile(registryPath);
    }
  }

  /** Build a registry from already-parsed entries (taps, portable manifests, tests). */
  static fromEntries(entries: MarketplaceEntry[]): MarketplaceRegistry {
    return new MarketplaceRegistry(parseMarketplaceEntries(entries));
  }

  private static parseFile(registryPath: string): MarketplaceRegistry {
    const raw = readFileSync(registryPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const list =
      typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { entries?: unknown }).entries)
        ? ((parsed as { entries: unknown[] }).entries as unknown[])
        : [];
    const entries = parseMarketplaceEntries(list);
    return new MarketplaceRegistry(entries);
  }

  /** Browse entries, optionally filtered by kind / tag / free-text query. */
  list(opts: { kind?: MarketplaceKind; tag?: string; q?: string } = {}): MarketplaceEntry[] {
    const q = (opts.q ?? '').trim().toLowerCase();
    return this.entries.filter((e) => {
      if (opts.kind && e.kind !== opts.kind) return false;
      if (opts.tag && !e.tags.includes(opts.tag)) return false;
      if (q) {
        const hay = `${e.name} ${e.description} ${e.creator} ${e.tags.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  get(kind: MarketplaceKind, id: string): MarketplaceEntry | undefined {
    return this.entries.find((e) => e.kind === kind && e.id === id);
  }

  getById(id: string): MarketplaceEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** Look up an entry by its `category:variant` package name (#155). */
  getByPackageName(packageName: string): MarketplaceEntry | undefined {
    return this.entries.find((e) => entryPackageName(e) === packageName);
  }

  count(): number {
    return this.entries.length;
  }

  kinds(): MarketplaceKind[] {
    return ['bot', 'skill', 'workflow', 'mcp-server', 'capability'];
  }
}

/**
 * Append one validated entry to a registry JSON file and invalidate the
 * manifest cache (used by tap/package registration, #157). Throws on a
 * duplicate kind:id or a malformed entry; a missing file starts empty.
 */
export function appendEntryToRegistryFile(registryPath: string, entry: MarketplaceEntry): void {
  let list: unknown[] = [];
  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as { entries?: unknown };
    if (Array.isArray(parsed.entries)) list = parsed.entries;
  } catch {
    list = [];
  }
  const next = parseMarketplaceEntries([...list, entry]); // validates + dedupes
  void next;
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({ entries: [...list, entry] }, null, 2) + '\n', 'utf8');
  registryFileCache.delete(registryPath);
}
