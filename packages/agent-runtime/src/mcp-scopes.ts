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
  }

  close(): void {
    this.db.close();
  }

  /** Current toggles for a tool; all-ON when never configured. */
  get(toolName: string): McpToolScopes {
    const row = this.db
      .prepare(`SELECT read, write, egress FROM tool_scopes WHERE tool_name = ?`)
      .get(toolName) as unknown as { read: number; write: number; egress: number } | undefined;
    if (!row) return { ...ALL_SCOPES_ON };
    return { read: row.read === 1, write: row.write === 1, egress: row.egress === 1 };
  }

  /**
   * Toggle scopes for a tool. Only the provided keys change; omitted keys
   * keep their current value. Returns the resulting toggle set.
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
    this.db
      .prepare(
        `INSERT INTO tool_scopes (tool_name, read, write, egress, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tool_name) DO UPDATE SET
           read = excluded.read, write = excluded.write, egress = excluded.egress,
           updated_at = excluded.updated_at`,
      )
      .run(name, next.read ? 1 : 0, next.write ? 1 : 0, next.egress ? 1 : 0, Date.now());
    return next;
  }

  /** All explicitly configured overrides (tool → toggles). */
  listOverrides(): Array<{ tool: string; scopes: McpToolScopes; updatedAt: number }> {
    const rows = this.db
      .prepare(`SELECT tool_name, read, write, egress, updated_at FROM tool_scopes ORDER BY tool_name ASC`)
      .all() as unknown as Array<{
      tool_name: string;
      read: number;
      write: number;
      egress: number;
      updated_at: number;
    }>;
    return rows.map((r) => ({
      tool: r.tool_name,
      scopes: { read: r.read === 1, write: r.write === 1, egress: r.egress === 1 },
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
  if (Object.keys(patch).length === 0) {
    throw new Error('body must toggle at least one of: read, write, egress');
  }
  return patch;
}
