// SPDX-License-Identifier: Apache-2.0
// CA-33: `.mcpb` importer — Claude Desktop Extension bundles.
//
// A .mcpb is a ZIP containing a manifest.json describing one MCP server
// (server.mcp_config / server.entry_point) plus the server's files.
// Importing it registers the server through the SAME governance path as
// a directory install: an explicit approval hook is required
// (deny-by-default, mirroring LazyMcpManager / marketplace MCP rules),
// nothing is spawned at import time, and env VALUES are never read from
// the bundle — only env NAMES (user_config keys / mcp_config env keys)
// become requiredEnv declarations, exactly like directory entries.
//
// Zip reading is self-contained (stored + deflate entries, traversal-
// safe, size-capped) so this package gains no new dependency.

import { inflateRawSync } from 'node:zlib';
import type { InstalledMcpServer, InstalledMcpServerConfig, LazyMcpServerStore } from './mcp-directory.js';
import { validateServerConfig, validateServerLabel } from './mcp-directory.js';

export class McpbError extends Error {
  constructor(message: string) { super(message); this.name = 'McpbError'; }
}

export class McpbImportDenied extends Error {
  constructor(label: string) { super(`.mcpb import denied by the approval hook: ${label}`); this.name = 'McpbImportDenied'; }
}

export interface McpbManifest {
  name: string;
  version?: string;
  description?: string;
  author?: { name?: string };
  server: {
    type?: string;
    entry_point?: string;
    mcp_config: { command: string; args?: string[]; env?: Record<string, string> };
  };
  user_config?: Record<string, unknown>;
  tools?: Array<{ name: string; description?: string }>;
}

export interface McpbBundle {
  manifest: McpbManifest;
  /** Entry names in the archive (server files are NOT extracted at import). */
  files: string[];
  label: string;
  config: InstalledMcpServerConfig;
}

// --- minimal zip reader (stored/deflate, traversal-safe, capped) ----------
const MAX_ENTRIES = 500;
const MAX_ENTRY = 16 * 1024 * 1024;

export function readMcpbEntries(buf: Buffer): Array<{ name: string; data: Buffer }> {
  if (buf.length < 22) throw new McpbError('not a .mcpb/zip file (too small)');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new McpbError('not a .mcpb/zip file (no end-of-central-directory)');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_ENTRIES) throw new McpbError(`.mcpb has too many entries (${count})`);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Array<{ name: string; data: Buffer }> = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new McpbError('corrupt .mcpb central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some((s) => s === '..')) {
      throw new McpbError(`unsafe .mcpb entry name: ${JSON.stringify(name)}`);
    }
    if (uncompSize > MAX_ENTRY) throw new McpbError(`.mcpb entry too large: ${name}`);
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) throw new McpbError(`corrupt .mcpb local header for ${name}`);
    const ln = buf.readUInt16LE(localOff + 26);
    const le = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + ln + le;
    const compressed = buf.subarray(start, start + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) { try { data = inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY }); } catch (e) { throw new McpbError(`failed to inflate ${name}: ${e instanceof Error ? e.message : String(e)}`); } }
    else throw new McpbError(`unsupported .mcpb compression method ${method} for ${name}`);
    out.push({ name, data });
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Derive a registry-safe label from a bundle name. */
export function mcpbLabel(name: string): string {
  const label = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  if (!label) throw new McpbError(`cannot derive a server label from bundle name ${JSON.stringify(name)}`);
  return label;
}

/** Parse + validate a .mcpb archive (in memory). Throws McpbError. */
export function parseMcpbBundle(buf: Buffer): McpbBundle {
  const entries = readMcpbEntries(buf);
  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  if (!manifestEntry) throw new McpbError('.mcpb is missing manifest.json at its root');
  let raw: unknown;
  try { raw = JSON.parse(manifestEntry.data.toString('utf8')); } catch (e) {
    throw new McpbError(`.mcpb manifest.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isRecord(raw)) throw new McpbError('.mcpb manifest.json must be an object');
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new McpbError('.mcpb manifest needs a name');
  if (!isRecord(raw.server) || !isRecord(raw.server.mcp_config)) throw new McpbError('.mcpb manifest needs server.mcp_config');
  const cfg = raw.server.mcp_config;
  if (typeof cfg.command !== 'string' || !cfg.command.trim()) throw new McpbError('.mcpb server.mcp_config.command must be a non-empty string');
  const args = Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === 'string') : [];
  // Substitute the bundle-dir placeholder the .mcpb spec uses for the
  // extracted location; the host replaces it again at spawn time, so we
  // keep a stable token instead of a machine-specific path.
  const manifest = raw as unknown as McpbManifest;
  const requiredEnv = new Set<string>();
  if (isRecord(cfg.env)) for (const k of Object.keys(cfg.env)) requiredEnv.add(k);
  if (isRecord(raw.user_config)) for (const k of Object.keys(raw.user_config)) requiredEnv.add(k);
  const label = mcpbLabel(manifest.name);
  validateServerLabel(label);
  const config: InstalledMcpServerConfig = {
    kind: 'stdio',
    command: cfg.command,
    args,
    ...(requiredEnv.size ? { requiredEnv: [...requiredEnv] } : {}),
  };
  validateServerConfig(config);
  return { manifest, files: entries.map((e) => e.name), label, config };
}

export interface ImportMcpbOptions {
  /** Governance prompt — SAME contract as directory installs. No hook = deny. */
  approve?: (info: { label: string; manifest: McpbManifest; config: InstalledMcpServerConfig }) => boolean | Promise<boolean>;
  /** When given, the validated server is registered (disabled=false, lazy — never spawned at import). */
  store?: Pick<LazyMcpServerStore, 'install'>;
  audit?: (action: string, fields: Record<string, unknown>) => void;
}

/**
 * Import a .mcpb bundle: validate, ask governance, then register via
 * the LazyMcpServerStore (the same store directory installs use).
 * Returns the parsed bundle plus the installed record when a store was given.
 */
export async function importMcpbBundle(
  buf: Buffer,
  opts: ImportMcpbOptions = {},
): Promise<{ bundle: McpbBundle; installed?: InstalledMcpServer }> {
  const bundle = parseMcpbBundle(buf);
  if (!opts.approve) {
    opts.audit?.('mcpb.import.denied', { label: bundle.label, reason: 'no approval hook (deny-by-default)' });
    throw new McpbImportDenied(bundle.label);
  }
  const ok = await opts.approve({ label: bundle.label, manifest: bundle.manifest, config: bundle.config });
  if (!ok) {
    opts.audit?.('mcpb.import.denied', { label: bundle.label, reason: 'approval hook returned false' });
    throw new McpbImportDenied(bundle.label);
  }
  opts.audit?.('mcpb.import.approved', { label: bundle.label, files: bundle.files.length });
  const installed = opts.store ? opts.store.install(null, bundle.label, bundle.config) : undefined;
  return { bundle, installed };
}
