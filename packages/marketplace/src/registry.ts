// SPDX-License-Identifier: Apache-2.0
// Marketplace registry: browse/install bots, skills, workflows, and MCP
// servers from a local registry JSON. Trust model:
//   - The registry is a local curator file (bundled with the server). It is
//     NOT fetched over the network, so installs never execute remote code.
//   - Third-party entries are tagged `untrusted: true` so the UI can warn.
//   - MCP server installs are approval-gated (deny-by-default): the
//     Installer refuses to write an MCP server config without a one-time
//     approval token issued only after a governance approval is approved.

import { readFileSync, statSync } from 'node:fs';

export type MarketplaceKind = 'bot' | 'skill' | 'workflow' | 'mcp-server';

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

export type MarketplacePayload =
  | MarketplaceBotPayload
  | MarketplaceSkillPayload
  | MarketplaceWorkflowPayload
  | MarketplaceMcpPayload;

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
}

function isKind(v: unknown): v is MarketplaceKind {
  return v === 'bot' || v === 'skill' || v === 'workflow' || v === 'mcp-server';
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
      return (
        typeof p.label === 'string' &&
        typeof p.command === 'string' &&
        Array.isArray(p.args) &&
        Array.isArray(p.requiredEnv)
      );
    default:
      return false;
  }
}

function isEntry(v: unknown): v is MarketplaceEntry {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!isKind(o.kind)) return false;
  return (
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

/**
 * Local curated marketplace registry. Loads from a single JSON file
 * (`{ entries: MarketplaceEntry[] }`). Malformed entries are rejected at
 * load time so a bad registry can never produce a half-valid install.
 */
/** Manifest cache: fromFile re-parses only when the file's mtime/size change. */
const registryFileCache = new Map<string, { sig: string; registry: MarketplaceRegistry }>();

/** Test hook: drop all cached registry manifests. */
export function clearMarketplaceRegistryCache(): void {
  registryFileCache.clear();
}

export class MarketplaceRegistry {
  private readonly entries: MarketplaceEntry[];

  private constructor(entries: MarketplaceEntry[]) {
    this.entries = entries;
  }

  static fromFile(registryPath: string): MarketplaceRegistry {
    // Manifest caching (Octomind parity): hosts call fromFile on
    // request paths; re-reading + re-validating a large registry JSON
    // per call is wasted work. The (mtime, size) signature invalidates
    // the cache the moment the manifest changes on disk.
    try {
      const st = statSync(registryPath);
      const sig = `${st.mtimeMs}:${st.size}`;
      const hit = registryFileCache.get(registryPath);
      if (hit && hit.sig === sig) return hit.registry;
      const registry = MarketplaceRegistry.parseFile(registryPath);
      registryFileCache.set(registryPath, { sig, registry });
      return registry;
    } catch (err) {
      // A missing/unreadable manifest keeps the historical behavior:
      // parseFile throws the descriptive error.
      if (registryFileCache.has(registryPath)) throw err;
      return MarketplaceRegistry.parseFile(registryPath);
    }
  }

  private static parseFile(registryPath: string): MarketplaceRegistry {
    const raw = readFileSync(registryPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const list =
      typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { entries?: unknown }).entries)
        ? ((parsed as { entries: unknown[] }).entries as unknown[])
        : [];
    const entries: MarketplaceEntry[] = [];
    const seen = new Set<string>();
    for (const item of list) {
      if (!isEntry(item)) {
        throw new Error(`marketplace registry: malformed entry at index ${list.indexOf(item)}`);
      }
      const key = `${item.kind}:${item.id}`;
      if (seen.has(key)) throw new Error(`marketplace registry: duplicate entry ${key}`);
      seen.add(key);
      entries.push(item);
    }
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

  count(): number {
    return this.entries.length;
  }

  kinds(): MarketplaceKind[] {
    return ['bot', 'skill', 'workflow', 'mcp-server'];
  }
}
