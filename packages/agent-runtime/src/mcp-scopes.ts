// SPDX-License-Identifier: Apache-2.0
// Per-tool MCP scopes (Laya-inspired, adapted — not copied): every tool
// exposed by the platform MCP server carries three independent toggles —
// Read, Write, Egress. The scope a call NEEDS is derived from the tool's
// nature (see requiredScopeForTool); the toggles decide whether that need
// is granted. A call whose required scope is disabled is denied with a
// clear error before governance evaluation runs.
//
// Scope meanings:
// - read:   the tool only reads local/platform data (files, memory, search
//           results rendered locally). No mutation, no network egress.
// - write:  the tool mutates local/platform state (files, memory, git,
//           shell). Includes everything 'read' does not cover.
// - egress: the tool transmits data to an external network endpoint
//           (remote MCP servers, webhooks, send/fetch tools).
//
// A tool has exactly one REQUIRED scope; the toggle for that scope must be
// ON for the call to proceed. Toggling an unrelated scope is a no-op for
// that tool but is still persisted (harmless, and it documents intent).
// Unknown tools default to all scopes ON (backward compatible — nothing
// that worked before breaks until an operator explicitly toggles).
//
// Persistence: SQLite `<dbPath>` (one table). The API exposes
// GET /api/mcp/tools and PATCH /api/mcp/tools/:id/scopes; the sibling web
// agent builds the settings panel on those.

// `node:sqlite` via the runtime builtin-module trick (vitest/Vite 5 cannot
// statically resolve the specifier) — same pattern as the other stores.
import { openDb } from './sqlite.js';
import type { DatabaseSync } from 'node:sqlite';
type DatabaseSyncType = DatabaseSync;

/** The three per-tool scope toggles. */
export type McpScope = 'read' | 'write' | 'egress';

export const MCP_SCOPES: ReadonlyArray<McpScope> = ['read', 'write', 'egress'];

/** Toggle set for one tool. All ON by default. */
export interface McpToolScopes {
  read: boolean;
  write: boolean;
  egress: boolean;
  /**
   * Domain-bound egress (#122): when egress is ON and this allowlist is
   * present and non-empty, the tool may transmit ONLY to destinations
   * whose host matches an entry — an exact host (`api.example.com`) or
   * a suffix wildcard (`*.example.com`, which also matches the bare
   * domain). Absent/empty = egress to any domain (the pre-#122
   * behaviour). When an allowlist exists and the call's destination
   * cannot be determined from its arguments, the call is denied
   * (fail-closed) — an operator who binds domains gets the binding.
   */
  domains?: string[];
}

/** True when `host` matches a domain allowlist entry (exact or `*.suffix`). */
export function domainMatchesAllowlist(host: string, domains: readonly string[]): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  for (const raw of domains) {
    const d = raw.trim().toLowerCase().replace(/\.$/, '');
    if (!d) continue;
    if (d.startsWith('*.')) {
      const suffix = d.slice(2);
      if (h === suffix || h.endsWith(`.${suffix}`)) return true;
    } else if (h === d) {
      return true;
    }
  }
  return false;
}

/**
 * Best-effort destination host for an egress call: the first argument
 * among the conventional URL keys that parses as a URL (or bare host).
 * Returns undefined when no destination can be determined.
 */
export function extractEgressHost(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const key of ['url', 'uri', 'endpoint', 'webhookUrl', 'webhook_url', 'baseUrl', 'base_url', 'target', 'host', 'hostname']) {
    const v = args[key];
    if (typeof v !== 'string' || v.trim() === '') continue;
    try {
      const u = new URL(v.includes('://') ? v : `https://${v}`);
      if (u.hostname) return u.hostname.toLowerCase();
    } catch {
      // Not a URL — keep looking through the other keys.
    }
  }
  return undefined;
}

export const ALL_SCOPES_ON: Readonly<McpToolScopes> = { read: true, write: true, egress: true };

// Tools that mutate local/platform state → required scope 'write'.
const WRITE_NAME_RE =
  /^(write_file|edit_file|create_file|delete_file|remove_file|memory_store|run_command|exec|shell|git_commit|git_push|git_branch|apply_patch|patch|checkpoint|record)/i;
// Tools that transmit data to an external network endpoint → 'egress'.
// `chat` is here: it always calls the cloud LLM, so disabling egress on it
// denies the tool entirely (fail closed).
const EGRESS_NAME_RE =
  /^(mcp:|https?:|send_|webhook|fetch|web_fetch|http_|chat$)/i;

/**
 * The single scope a tool call requires, derived from the tool's nature:
 * - external network destinations (mcp:<server>:*, http*, send_*, webhook,
 *   fetch_*, chat) → 'egress'
 * - local mutation (file writes, memory_store, shell, git mutating ops) → 'write'
 * - everything else (reads, local search) → 'read'
 *
 * Conservative by default: an unrecognized tool is 'read' only when it
 * matches neither list; governance policy still applies on top, so this
 * never widens what the policy allows.
 */
export function requiredScopeForTool(toolName: string): McpScope {
  const name = toolName.trim();
  if (EGRESS_NAME_RE.test(name)) return 'egress';
  if (WRITE_NAME_RE.test(name)) return 'write';
  return 'read';
}

/** Human sentence describing a scope, for settings UIs and errors. */
export function describeScope(scope: McpScope): string {
  switch (scope) {
    case 'read':
      return 'Read — the tool only reads local/platform data';
    case 'write':
      return 'Write — the tool may mutate local/platform state';
    case 'egress':
      return 'Egress — the tool may transmit data to an external network endpoint';
  }
}

function coerceBool(v: unknown): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === true || v === false) return v;
  throw new Error(`scope toggles must be booleans, got ${JSON.stringify(v)}`);
}

/**
 * SQLite-backed per-tool scope toggles. Only overrides are persisted;
 * tools with no row resolve to all-ON.
 */
export class McpScopeStore {
  private readonly db: DatabaseSyncType;

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_scopes (
        tool_name TEXT PRIMARY KEY,
        read INTEGER NOT NULL DEFAULT 1,
        write INTEGER NOT NULL DEFAULT 1,
        egress INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
    `);
    // #122 migration: domain allowlist column for pre-existing stores.
    const cols = this.db.prepare(`PRAGMA table_info(tool_scopes)`).all() as unknown as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'domains')) {
      this.db.exec(`ALTER TABLE tool_scopes ADD COLUMN domains TEXT`);
    }
  }

  close(): void {
    this.db.close();
  }

  /** Current toggles for a tool; all-ON when never configured. */
  get(toolName: string): McpToolScopes {
    const row = this.db
      .prepare(`SELECT read, write, egress, domains FROM tool_scopes WHERE tool_name = ?`)
      .get(toolName) as unknown as { read: number; write: number; egress: number; domains: string | null } | undefined;
    if (!row) return { ...ALL_SCOPES_ON };
    return {
      read: row.read === 1,
      write: row.write === 1,
      egress: row.egress === 1,
      ...(row.domains ? { domains: parseDomains(row.domains) } : {}),
    };
  }

  /**
   * Toggle scopes for a tool. Only the provided keys change; omitted keys
   * keep their current value. Returns the resulting toggle set.
   * `domains` (when provided) replaces the egress allowlist wholesale;
   * an empty array clears the binding (egress to any domain).
   */
  set(toolName: string, patch: Partial<McpToolScopes>): McpToolScopes {
    const name = toolName.trim();
    if (!name) throw new Error('tool name must be a non-empty string');
    const current = this.get(name);
    const next: McpToolScopes = {
      read: coerceBool(patch.read) ?? current.read,
      write: coerceBool(patch.write) ?? current.write,
      egress: coerceBool(patch.egress) ?? current.egress,
    };
    let domains: string[] | undefined = current.domains;
    if (patch.domains !== undefined) {
      if (!Array.isArray(patch.domains) || !patch.domains.every((d) => typeof d === 'string' && d.trim().length > 0)) {
        throw new Error('scope "domains" must be an array of non-empty domain strings');
      }
      domains = patch.domains.length > 0 ? [...patch.domains] : undefined;
    }
    if (domains) next.domains = domains;
    this.db
      .prepare(
        `INSERT INTO tool_scopes (tool_name, read, write, egress, domains, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tool_name) DO UPDATE SET
           read = excluded.read, write = excluded.write, egress = excluded.egress,
           domains = excluded.domains, updated_at = excluded.updated_at`,
      )
      .run(name, next.read ? 1 : 0, next.write ? 1 : 0, next.egress ? 1 : 0, domains ? JSON.stringify(domains) : null, Date.now());
    return next;
  }

  /** All explicitly configured overrides (tool → toggles). */
  listOverrides(): Array<{ tool: string; scopes: McpToolScopes; updatedAt: number }> {
    const rows = this.db
      .prepare(`SELECT tool_name, read, write, egress, domains, updated_at FROM tool_scopes ORDER BY tool_name ASC`)
      .all() as unknown as Array<{
      tool_name: string;
      read: number;
      write: number;
      egress: number;
      domains: string | null;
      updated_at: number;
    }>;
    return rows.map((r) => ({
      tool: r.tool_name,
      scopes: {
        read: r.read === 1,
        write: r.write === 1,
        egress: r.egress === 1,
        ...(r.domains ? { domains: parseDomains(r.domains) } : {}),
      },
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Enforcement check for one tool call. Returns the required scope and
   * whether its toggle is ON.
   */
  check(toolName: string): { required: McpScope; granted: boolean; scopes: McpToolScopes } {
    const required = requiredScopeForTool(toolName);
    const scopes = this.get(toolName);
    return { required, granted: scopes[required], scopes };
  }

  /**
   * Domain-bound egress check (#122): for an egress call, combine the
   * egress toggle with the tool's domain allowlist (when bound).
   * Fail-closed when a binding exists and the destination host is
   * unknown or not on the list.
   */
  checkEgress(
    toolName: string,
    args?: Record<string, unknown>,
  ): { granted: boolean; host?: string; reason?: string; scopes: McpToolScopes } {
    const scopes = this.get(toolName);
    if (!scopes.egress) return { granted: false, reason: 'egress scope is disabled for this tool', scopes };
    const domains = scopes.domains;
    if (!domains || domains.length === 0) return { granted: true, scopes };
    const host = extractEgressHost(args);
    if (!host) {
      return {
        granted: false,
        reason: `tool is bound to domains [${domains.join(', ')}] but the call's destination could not be determined from its arguments`,
        scopes,
      };
    }
    if (!domainMatchesAllowlist(host, domains)) {
      return { granted: false, host, reason: `destination ${host} is not in this tool's domain allowlist [${domains.join(', ')}]`, scopes };
    }
    return { granted: true, host, scopes };
  }
}

function parseDomains(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Per-server tool filtering with wildcards (Octomind parity #55)
// ---------------------------------------------------------------------------
//
// Separate from the per-tool scope toggles above: a filter is attached to
// ONE MCP server and decides which of THAT server's tools are exposed at
// all. Patterns are globs where `*` matches any (possibly empty) run of
// characters; every other character matches literally, and the pattern is
// anchored (the whole tool name must match). A pattern without `*` is an
// exact-name toggle — the pre-existing behaviour — and keeps working.
//
// Semantics:
// - `deny` wins over `allow`, always.
// - When `allow` is present and non-empty, a tool must match at least one
//   allow pattern to be exposed.
// - When `allow` is absent/empty, everything not denied is exposed
//   (backward compatible: an empty filter exposes the full surface).

/** Allow/deny glob filter for one MCP server's tool surface. */
export interface McpServerToolFilter {
  allow?: string[];
  deny?: string[];
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

/** True when `toolName` matches the glob `pattern` (`*` = any run of chars). */
export function matchToolPattern(pattern: string, toolName: string): boolean {
  if (typeof pattern !== 'string' || pattern.length === 0) return false;
  return globToRegExp(pattern).test(toolName);
}

/** True when a filter exposes `toolName` (deny wins; non-empty allow gates). */
export function isToolAllowedByFilter(
  filter: McpServerToolFilter | undefined | null,
  toolName: string,
): boolean {
  if (!filter) return true;
  const deny = filter.deny ?? [];
  if (deny.some((p) => matchToolPattern(p, toolName))) return false;
  const allow = filter.allow ?? [];
  if (allow.length === 0) return true;
  return allow.some((p) => matchToolPattern(p, toolName));
}

/** The subset of `names` a filter exposes, order preserved. */
export function filterToolNames<T extends string>(filter: McpServerToolFilter | undefined | null, names: readonly T[]): T[] {
  return names.filter((n) => isToolAllowedByFilter(filter, n));
}

/** Validate/normalize an untrusted filter body; throws on bad shapes. */
export function parseServerToolFilter(body: unknown): McpServerToolFilter {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('tool filter must be an object like { "allow": ["read_*"], "deny": ["*_write"] }');
  }
  const out: McpServerToolFilter = {};
  for (const key of ['allow', 'deny'] as const) {
    const v = (body as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every((p) => typeof p === 'string' && p.length > 0)) {
      throw new Error(`tool filter "${key}" must be an array of non-empty pattern strings`);
    }
    out[key] = [...(v as string[])];
  }
  return out;
}

/**
 * In-memory registry of per-server tool filters, keyed by server label.
 * Hosts that need durability persist the same shape through
 * LazyMcpServerStore.setToolFilter (mcp-directory.ts), which is backed by
 * this class's semantics; this class is the embedder/test seam.
 */
export class McpServerFilterSet {
  private readonly filters = new Map<string, McpServerToolFilter>();

  set(serverLabel: string, filter: McpServerToolFilter): void {
    this.filters.set(serverLabel, parseServerToolFilter(filter));
  }

  get(serverLabel: string): McpServerToolFilter | undefined {
    return this.filters.get(serverLabel);
  }

  clear(serverLabel: string): boolean {
    return this.filters.delete(serverLabel);
  }

  /** True when the server's filter exposes `toolName`. No filter → exposed. */
  allows(serverLabel: string, toolName: string): boolean {
    return isToolAllowedByFilter(this.filters.get(serverLabel), toolName);
  }

  /** Filter a server's tool names down to the exposed subset. */
  exposedNames(serverLabel: string, names: readonly string[]): string[] {
    return filterToolNames(this.filters.get(serverLabel), names);
  }
}

/** Validate a PATCH /mcp/tools/:id/scopes body; throws on bad input. */
export function parseScopePatch(body: unknown): Partial<McpToolScopes> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('body must be an object like { "read": true, "egress": false }');
  }
  const patch: Partial<McpToolScopes> = {};
  for (const key of MCP_SCOPES) {
    const v = (body as Record<string, unknown>)[key];
    const b = coerceBool(v);
    if (b !== undefined) patch[key] = b;
  }
  // Domain binding (#122): `domains` replaces the egress allowlist
  // (empty array clears it). Validated here so bad shapes 400 cleanly.
  const domains = (body as Record<string, unknown>).domains;
  if (domains !== undefined) {
    if (!Array.isArray(domains) || !domains.every((d) => typeof d === 'string' && d.trim().length > 0)) {
      throw new Error('"domains" must be an array of non-empty domain strings (an empty array clears the binding)');
    }
    patch.domains = [...(domains as string[])];
  }
  if (Object.keys(patch).length === 0) {
    throw new Error('body must toggle at least one of: read, write, egress, domains');
  }
  return patch;
}
